#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <limits.h>
#include <pwd.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static volatile sig_atomic_t stop_requested = 0;
static volatile sig_atomic_t stop_signal_number = SIGTERM;
static volatile sig_atomic_t worker_group_pid = -1;

static void fail(const char *message) {
  fprintf(stderr, "host-exec-launcher: %s\n", message);
  exit(126);
}

static unsigned long long parse_id(const char *value, const char *label) {
  char *end = NULL;
  errno = 0;
  unsigned long long parsed = strtoull(value, &end, 10);
  if (errno != 0 || end == value || *end != '\0' || parsed == 0 || parsed > UINT_MAX) {
    fprintf(stderr, "host-exec-launcher: invalid %s\n", label);
    exit(126);
  }
  return parsed;
}

static void require_absolute(const char *value, const char *label) {
  if (value == NULL || value[0] != '/') {
    fprintf(stderr, "host-exec-launcher: %s must be absolute\n", label);
    exit(126);
  }
}

static void require_root_owned_executable(const char *binary) {
  struct stat info;
  if (lstat(binary, &info) != 0 || !S_ISREG(info.st_mode) || info.st_uid != 0 ||
      (info.st_mode & 0777) != 0755) {
    fail("provider binary must be a root-owned 0755 regular file");
  }
}

static void require_no_supplementary_groups(void) {
  int group_count = getgroups(0, NULL);
  if (group_count < 0) fail("cannot read supplementary groups");
  if (group_count == 0) return;
  gid_t *groups = calloc((size_t)group_count, sizeof(gid_t));
  if (groups == NULL || getgroups(group_count, groups) != group_count) {
    free(groups);
    fail("cannot read supplementary groups");
  }
#if defined(__APPLE__)
  // Darwin reports the effective primary GID as the sole getgroups entry
  // even when no supplementary groups are present.
  const int onlyPrimaryGroup = group_count == 1 && groups[0] == getegid();
#else
  const int onlyPrimaryGroup = 0;
#endif
  free(groups);
  if (!onlyPrimaryGroup) fail("supplementary groups were not cleared");
}

static void forward_stop_signal(int signal_number) {
  stop_requested = 1;
  stop_signal_number = signal_number;
  if (worker_group_pid > 0) {
    // The keeper remains the process-group leader until the final SIGKILL.
    // The group therefore cannot disappear and be recycled between this
    // liveness check and the signal while the keeper is present.
    (void)kill(-worker_group_pid, signal_number);
  }
}

static int worker_group_alive(pid_t pid) {
  if (pid <= 0) return 0;
  if (kill(-pid, 0) == 0) return 1;
  return errno == EPERM;
}

static void stop_worker_group(pid_t pid) {
  if (pid <= 0 || !worker_group_alive(pid)) return;
  (void)kill(-pid, SIGTERM);
  struct timespec pause = {0, 25 * 1000 * 1000};
  for (int attempt = 0; attempt < 40; attempt += 1) {
    if (!worker_group_alive(pid)) return;
    (void)nanosleep(&pause, NULL);
  }
  if (worker_group_alive(pid)) (void)kill(-pid, SIGKILL);
  for (int attempt = 0; attempt < 40 && worker_group_alive(pid); attempt += 1) {
    (void)nanosleep(&pause, NULL);
  }
}

static int write_all(int fd, const void *buffer, size_t length) {
  const char *bytes = (const char *)buffer;
  size_t written = 0;
  while (written < length) {
    ssize_t result = write(fd, bytes + written, length - written);
    if (result > 0) {
      written += (size_t)result;
      continue;
    }
    if (result < 0 && errno == EINTR) continue;
    return -1;
  }
  return 0;
}

static int read_worker_status(int fd, int *status) {
  char *bytes = (char *)status;
  size_t read_bytes = 0;
  while (read_bytes < sizeof(*status)) {
    ssize_t result = read(fd, bytes + read_bytes, sizeof(*status) - read_bytes);
    if (result > 0) {
      read_bytes += (size_t)result;
      continue;
    }
    if (result < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) {
      if (stop_requested) return -1;
      struct timespec pause = {0, 10 * 1000 * 1000};
      (void)nanosleep(&pause, NULL);
      continue;
    }
    return -1;
  }
  return 0;
}

static int read_keeper_ready(int fd) {
  char ready = 0;
  for (int attempt = 0; attempt < 500; attempt += 1) {
    ssize_t result = read(fd, &ready, sizeof(ready));
    if (result == (ssize_t)sizeof(ready) && ready == 'R') return 0;
    if (result == 0) return -1;
    if (result < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)) {
      struct timespec pause = {0, 10 * 1000 * 1000};
      (void)nanosleep(&pause, NULL);
      continue;
    }
    return -1;
  }
  return -1;
}

static void hold_keeper(pid_t supervisor_pid) {
  // Soft signals are forwarded to the actual provider. Keeping this stable
  // anchor alive makes the numeric PGID identity non-recyclable until the
  // parent performs the one final group SIGKILL.  The parent check is a
  // portable parent-death watchdog for signals that cannot be caught or for a
  // launcher crash between signal-handler installation and teardown.
  (void)signal(SIGTERM, SIG_IGN);
  (void)signal(SIGINT, SIG_IGN);
  (void)signal(SIGHUP, SIG_IGN);
  (void)signal(SIGQUIT, SIG_IGN);
  for (;;) {
    if (getppid() != supervisor_pid) {
      // The keeper is the process-group leader.  Killing group 0 from within
      // the keeper terminates both the unprivileged provider and this anchor.
      (void)kill(0, SIGKILL);
      _exit(137);
    }
    struct timespec pause = {0, 25 * 1000 * 1000};
    (void)nanosleep(&pause, NULL);
  }
}

static void run_worker_keeper(int status_fd, int ready_fd, const sigset_t *blocked_signals,
                              const char *binary, char **child_argv, char **envp) {
  const pid_t supervisor_pid = getppid();
  if (setpgid(0, 0) != 0) fail("cannot create the stable provider process group");
  (void)signal(SIGTERM, SIG_IGN);
  (void)signal(SIGINT, SIG_IGN);
  (void)signal(SIGHUP, SIG_IGN);
  (void)signal(SIGQUIT, SIG_IGN);
  const char ready = 'R';
  if (write_all(ready_fd, &ready, sizeof(ready)) != 0) fail("cannot publish provider process-group readiness");
  close(ready_fd);
  if (sigprocmask(SIG_UNBLOCK, blocked_signals, NULL) != 0) {
    fail("cannot unblock provider termination signals after keeper readiness");
  }
  pid_t worker = fork();
  if (worker < 0) {
    int status = 126 << 8;
    (void)write_all(status_fd, &status, sizeof(status));
    hold_keeper(supervisor_pid);
  }
  if (worker == 0) {
    // Only the keeper ignores soft signals; the provider receives normal
    // semantics and can therefore be terminated before the final escalation.
    (void)signal(SIGTERM, SIG_DFL);
    (void)signal(SIGINT, SIG_DFL);
    (void)signal(SIGHUP, SIG_DFL);
    (void)signal(SIGQUIT, SIG_DFL);
    execve(binary, child_argv, envp);
    fprintf(stderr, "host-exec-launcher: execve failed: %s\n", strerror(errno));
    _exit(126);
  }
  int status = 0;
  for (;;) {
    pid_t waited = waitpid(worker, &status, 0);
    if (waited == worker) break;
    if (waited < 0 && errno == EINTR) continue;
    status = 126 << 8;
    break;
  }
  (void)write_all(status_fd, &status, sizeof(status));
  hold_keeper(supervisor_pid);
}

int main(int argc, char **argv, char **envp) {
  if (geteuid() != 0 || getuid() != 0) fail("launcher must start with administrator authority");
  if (argc < 10 || strcmp(argv[1], "--uid") != 0 || strcmp(argv[3], "--gid") != 0 ||
      strcmp(argv[5], "--cwd") != 0 || strcmp(argv[7], "--binary") != 0 ||
      strcmp(argv[9], "--") != 0) {
    fail("usage: launcher --uid <uid> --gid <gid> --cwd <dir> --binary <file> -- <argv>");
  }

  uid_t uid = (uid_t)parse_id(argv[2], "uid");
  gid_t gid = (gid_t)parse_id(argv[4], "gid");
  const char *cwd = argv[6];
  const char *binary = argv[8];
  require_absolute(cwd, "cwd");
  require_absolute(binary, "binary");
  require_root_owned_executable(binary);
  struct passwd *account = getpwuid(uid);
  if (account == NULL || account->pw_gid != gid) {
    fail("requested gid is not the requested user's primary group");
  }

  if (chdir(cwd) != 0) fail("cannot enter the fixed execution bundle");
  if (setgid(gid) != 0) fail("cannot set the requested primary group");
  // macOS refreshes the effective group while changing the group access list;
  // restore the requested primary group before dropping uid.
  if (setgroups(0, NULL) != 0) fail("cannot clear supplementary groups");
  if (setgid(gid) != 0) fail("cannot restore the requested primary group");
  if (setuid(uid) != 0) fail("cannot set the requested user");
  if (geteuid() != uid || getegid() != gid) fail("requested run-as identity was not applied");
  require_no_supplementary_groups();

  char **child_argv = calloc((size_t)(argc - 8), sizeof(char *));
  if (child_argv == NULL) fail("cannot allocate child argv");
  child_argv[0] = (char *)binary;
  for (int index = 10; index < argc; index += 1) child_argv[index - 9] = argv[index];

  int status_pipe[2];
  if (pipe(status_pipe) != 0) fail("cannot create the provider status channel");
  int flags = fcntl(status_pipe[0], F_GETFL, 0);
  if (flags < 0 || fcntl(status_pipe[0], F_SETFL, flags | O_NONBLOCK) != 0) {
    fail("cannot configure the provider status channel");
  }
  int ready_pipe[2];
  if (pipe(ready_pipe) != 0) fail("cannot create the provider readiness channel");
  int ready_flags = fcntl(ready_pipe[0], F_GETFL, 0);
  if (ready_flags < 0 || fcntl(ready_pipe[0], F_SETFL, ready_flags | O_NONBLOCK) != 0) {
    fail("cannot configure the provider readiness channel");
  }
  // Block termination signals across fork and handler installation. Without
  // this small handoff window a signal can kill the root-owned launcher after
  // the keeper is created but before `worker_group_pid` and forwarding are
  // ready, orphaning the unprivileged provider group.
  sigset_t blocked_signals;
  if (sigemptyset(&blocked_signals) != 0 ||
      sigaddset(&blocked_signals, SIGTERM) != 0 ||
      sigaddset(&blocked_signals, SIGINT) != 0 ||
      sigaddset(&blocked_signals, SIGHUP) != 0 ||
      sigaddset(&blocked_signals, SIGQUIT) != 0 ||
      sigprocmask(SIG_BLOCK, &blocked_signals, NULL) != 0) {
    fail("cannot block bounded provider termination signals");
  }
  pid_t keeper = fork();
  if (keeper < 0) fail("cannot fork the stable provider process-group keeper");
  if (keeper == 0) {
    close(status_pipe[0]);
    close(ready_pipe[0]);
    run_worker_keeper(status_pipe[1], ready_pipe[1], &blocked_signals, binary, child_argv, envp);
    _exit(126);
  }
  close(status_pipe[1]);
  close(ready_pipe[1]);
  // Signals remain blocked while the parent waits for a positive keeper
  // readiness byte. No handler can target a guessed PGID before setpgid(0, 0)
  // has succeeded in the keeper.
  const int keeper_ready = read_keeper_ready(ready_pipe[0]) == 0;
  close(ready_pipe[0]);
  if (!keeper_ready) {
    if (waitpid(keeper, NULL, WNOHANG) == 0) (void)kill(keeper, SIGKILL);
    (void)waitpid(keeper, NULL, 0);
    close(status_pipe[0]);
    return 126;
  }
  worker_group_pid = keeper;
  if (signal(SIGTERM, forward_stop_signal) == SIG_ERR ||
      signal(SIGINT, forward_stop_signal) == SIG_ERR ||
      signal(SIGHUP, forward_stop_signal) == SIG_ERR ||
      signal(SIGQUIT, forward_stop_signal) == SIG_ERR) {
    fail("cannot install bounded provider signal forwarding");
  }
  if (sigprocmask(SIG_UNBLOCK, &blocked_signals, NULL) != 0) {
    fail("cannot unblock bounded provider termination signals");
  }
  int worker_status = 126 << 8;
  const int status_read = read_worker_status(status_pipe[0], &worker_status);
  close(status_pipe[0]);
  if (stop_requested || status_read != 0) {
    stop_worker_group(keeper);
    (void)waitpid(keeper, NULL, 0);
    worker_group_pid = -1;
    if (stop_requested) return 128 + stop_signal_number;
    return 126;
  }
  // The keeper intentionally remains alive after the provider reports. This
  // final bounded teardown is the only point at which the numeric PGID is
  // escalated, and the keeper still occupies it until SIGKILL is delivered.
  stop_worker_group(keeper);
  (void)waitpid(keeper, NULL, 0);
  worker_group_pid = -1;
  if (WIFEXITED(worker_status)) return WEXITSTATUS(worker_status);
  if (WIFSIGNALED(worker_status)) return 128 + WTERMSIG(worker_status);
  return 126;
}

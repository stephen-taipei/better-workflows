#include <errno.h>
#include <grp.h>
#include <limits.h>
#include <pwd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

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
  if (setgroups(0, NULL) != 0) fail("cannot clear supplementary groups");
  if (setgid(gid) != 0) fail("cannot set the requested primary group");
  if (setuid(uid) != 0) fail("cannot set the requested user");
  if (geteuid() != uid || getegid() != gid) fail("requested run-as identity was not applied");
  if (getgroups(0, NULL) != 0) fail("supplementary groups were not cleared");

  char **child_argv = calloc((size_t)(argc - 8), sizeof(char *));
  if (child_argv == NULL) fail("cannot allocate child argv");
  child_argv[0] = (char *)binary;
  for (int index = 10; index < argc; index += 1) child_argv[index - 9] = argv[index];
  execve(binary, child_argv, envp);
  fprintf(stderr, "host-exec-launcher: execve failed: %s\n", strerror(errno));
  return 126;
}

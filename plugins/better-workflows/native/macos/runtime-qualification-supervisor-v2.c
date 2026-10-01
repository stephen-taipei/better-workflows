/* SPDX-License-Identifier: AGPL-3.0-only
 * SOURCE PROPOSAL ONLY. No build, signing, installation or host qualification receipt.
 * macOS consumer startup boundary; not a CI producer/job containment program.
 *
 * Trust BEFORE main is supplied by an independently reviewed protected install
 * and OS-enforced hardened code signing of THIS native executable. The checks
 * below cannot repair dyld injection or a compromised image before main.
 *
 * This source selects a conservative non-ad-hoc signing profile with explicit
 * runtime/library/hard/kill flags and zero entitlements. The profile is not
 * proven to be the only solution; no signer or provisioning grant is implied.
 *
 * Root must provide an approved build-time pins header (e.g. via -include).
 * No caller argv, environment variable or candidate manifest may set these pins.
 * The final signed image's SHA256/CDHashes and dependencies must be recorded
 * externally; embedding its own final digest would be circular.
 */
#define _DARWIN_C_SOURCE 1
#if !defined(__APPLE__) || !(defined(__aarch64__) || defined(__arm64__) || defined(__x86_64__))
#error "Runtime V2 supervisor proposal supports macOS arm64/x86_64 only"
#endif
#ifndef SBW_EXPECTED_BOOTSTRAP_SHA256
#error "Missing independently approved exact bootstrap-v2.json SHA256"
#endif
#ifndef SBW_EXPECTED_LAUNCHER_SHA256
#error "Missing independently approved exact launcher SHA256"
#endif
#ifndef SBW_SUPERVISOR_SIGNING_REQUIREMENT
#error "Missing independently approved non-ad-hoc supervisor signing requirement"
#endif

#include <CommonCrypto/CommonDigest.h>
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <pwd.h>
#include <signal.h>
#include <spawn.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/acl.h>
#include <sys/param.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#define INSTALL "/private/var/db/better-workflows/runtime-verifier-v2"
#define SUPERVISOR INSTALL "/runtime-qualification-supervisor-v2"
#define MANIFEST INSTALL "/bootstrap-v2.json"
#define LAUNCHER INSTALL "/runtime-qualification-launch-v2.sh"
#define SHELL "/bin/sh"
#define MAX_SNAPSHOTS 64
#define MAX_MANIFEST_BYTES (64U * 1024U)
#define MAX_LAUNCHER_BYTES (1024U * 1024U)
#define MAX_NATIVE_BYTES (64U * 1024U * 1024U)
#define MAX_RUN_ID_BYTES 64U
#define PW_BUFFER_BYTES (64U * 1024U)

extern char **environ;
static char *empty_environment[] = { NULL };
static const char expected_manifest[] = SBW_EXPECTED_BOOTSTRAP_SHA256;
static const char expected_launcher[] = SBW_EXPECTED_LAUNCHER_SHA256;
static const char signing_requirement[] = SBW_SUPERVISOR_SIGNING_REQUIREMENT;

struct snapshot { char path[PATH_MAX]; struct stat identity; };
static struct snapshot snapshots[MAX_SNAPSHOTS];
static size_t snapshot_count;
struct protected_file { const char *path; int fd; struct stat identity; };

static _Noreturn void hold(const char *reason) {
  /* Fixed messages only: never print caller values, environment or credentials. */
  (void)dprintf(STDERR_FILENO, "Runtime V2 supervisor HOLD: %s; no trusted audit receipt\n", reason);
  _exit(126);
}

static bool same_identity(const struct stat *a, const struct stat *b) {
  /* Access time changes during hashing are intentionally excluded. */
  return a->st_dev == b->st_dev && a->st_ino == b->st_ino &&
    a->st_mode == b->st_mode && a->st_uid == b->st_uid && a->st_gid == b->st_gid &&
    a->st_nlink == b->st_nlink && a->st_size == b->st_size && a->st_flags == b->st_flags &&
    a->st_ctimespec.tv_sec == b->st_ctimespec.tv_sec &&
    a->st_ctimespec.tv_nsec == b->st_ctimespec.tv_nsec &&
    a->st_mtimespec.tv_sec == b->st_mtimespec.tv_sec &&
    a->st_mtimespec.tv_nsec == b->st_mtimespec.tv_nsec;
}

static void require_no_acl(int fd) {
  acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
  /* Unsupported/unreadable ACL state is not evidence of an absent ACL. */
  if (acl == NULL) hold("ACL unavailable");
  if (acl_valid(acl) != 0) { (void)acl_free(acl); hold("invalid ACL"); }
  acl_entry_t entry = NULL;
  errno = 0;
  int result = acl_get_entry(acl, ACL_FIRST_ENTRY, &entry);
  int saved_errno = errno;
  (void)acl_free(acl);
  /* Darwin: 0 means an entry exists; -1/EINVAL after a valid ACL means no entry.
   * Do not use Linux's 1-success/0-end convention. Host qualification must
   * confirm empty, allow and deny ACL fixtures on each supported macOS host. */
  if (result != -1 || saved_errno != EINVAL) hold("ACL present or indeterminate");
}

static void observe_path(const char *path, const struct stat *identity, bool initial) {
  for (size_t i = 0; i < snapshot_count; ++i) {
    if (strcmp(snapshots[i].path, path) == 0) {
      if (!same_identity(&snapshots[i].identity, identity)) hold("protected path drift");
      return;
    }
  }
  if (!initial || snapshot_count == MAX_SNAPSHOTS) hold("unexpected protected path");
  size_t length = strlen(path);
  if (length >= sizeof(snapshots[0].path)) hold("protected path bound");
  memcpy(snapshots[snapshot_count].path, path, length + 1);
  snapshots[snapshot_count++].identity = *identity;
}

static void check_descriptor(int fd, const char *path, bool directory,
                             const struct stat *before, bool initial) {
  struct stat current;
  char physical[MAXPATHLEN];
  if (fstat(fd, &current) != 0 || !same_identity(before, &current) ||
      current.st_uid != 0 || (current.st_mode & 0022) != 0 ||
      (current.st_mode & 07000) != 0 ||
      (directory ? !S_ISDIR(current.st_mode) : !S_ISREG(current.st_mode)) ||
      (!directory && current.st_nlink != 1)) hold("unprotected descriptor");
  require_no_acl(fd);
  /* F_GETPATH preserves the normal firmlink spelling; NOFIRMLINK would return
   * the underlying Data volume spelling and is deliberately not used here. */
  if (fcntl(fd, F_GETPATH, physical) != 0 || strcmp(physical, path) != 0)
    hold("noncanonical protected path");
  struct stat after_acl;
  if (fstat(fd, &after_acl) != 0 || !same_identity(&current, &after_acl))
    hold("descriptor changed during ACL check");
  observe_path(path, &current, initial);
}

static struct protected_file open_protected_file(const char *path, size_t max_bytes,
                                                 bool executable, bool initial) {
  /* All input paths to this walker are compile-time fixed, absolute, physical
   * paths. Each ancestor is opened relative to a checked descriptor with
   * O_NOFOLLOW; every path-vs-fd identity is compared before accepting it. */
  if (path == NULL || path[0] != '/' || strlen(path) >= PATH_MAX) hold("fixed path invalid");
  int current_fd = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK);
  struct stat before;
  if (current_fd < 0 || fstat(current_fd, &before) != 0) hold("cannot open trust root");
  check_descriptor(current_fd, "/", true, &before, initial);
  char prefix[PATH_MAX] = "/";
  const char *part = path + 1;
  while (*part != '\0') {
    const char *separator = strchr(part, '/');
    size_t length = separator == NULL ? strlen(part) : (size_t)(separator - part);
    bool directory = separator != NULL;
    char component[NAME_MAX + 1];
    if (length == 0 || length > NAME_MAX) hold("fixed component bound");
    memcpy(component, part, length);
    component[length] = '\0';
    if (strcmp(component, ".") == 0 || strcmp(component, "..") == 0) hold("fixed component invalid");
    size_t prefix_length = strlen(prefix);
    bool add_separator = prefix_length > 1;
    if (prefix_length + (add_separator ? 1U : 0U) + length >= sizeof(prefix))
      hold("fixed path bound");
    if (add_separator) prefix[prefix_length++] = '/';
    memcpy(prefix + prefix_length, component, length + 1);
    if (fstatat(current_fd, component, &before, AT_SYMLINK_NOFOLLOW) != 0)
      hold("cannot inspect protected component");
    int flags = O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK;
    if (directory) flags |= O_DIRECTORY;
    int next_fd = openat(current_fd, component, flags);
    if (next_fd < 0) hold("cannot open protected component");
    check_descriptor(next_fd, prefix, directory, &before, initial);
    (void)close(current_fd);
    current_fd = next_fd;
    if (!directory) break;
    part = separator + 1;
  }
  struct stat identity;
  if (fstat(current_fd, &identity) != 0 || !S_ISREG(identity.st_mode) ||
      identity.st_size < 1 || (uint64_t)identity.st_size > (uint64_t)max_bytes ||
      (executable && (identity.st_mode & 0111) == 0)) hold("protected file bound or mode");
  return (struct protected_file){ .path = path, .fd = current_fd, .identity = identity };
}

static bool lowercase_hex(const char *value, size_t wanted) {
  if (value == NULL || strnlen(value, wanted + 1) != wanted) return false;
  for (size_t i = 0; i < wanted; ++i)
    if (!((value[i] >= '0' && value[i] <= '9') || (value[i] >= 'a' && value[i] <= 'f'))) return false;
  return true;
}

/* CommonCrypto SHA256 is used only to hash already protected bounded fds.
 * Its C SHA256 API is deprecated in newer SDKs but remains in libSystem. A
 * CryptoKit bridge would enlarge this startup TCB; no blanket warning waiver. */
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
static void require_digest(struct protected_file *file, const char *expected) {
  unsigned char buffer[64U * 1024U];
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  static const char hex[] = "0123456789abcdef";
  char actual[2U * CC_SHA256_DIGEST_LENGTH + 1U];
  CC_SHA256_CTX hash;
  if (!lowercase_hex(expected, 64) || CC_SHA256_Init(&hash) != 1) hold("digest pin invalid");
  off_t offset = 0;
  while (offset < file->identity.st_size) {
    off_t remaining = file->identity.st_size - offset;
    size_t requested = remaining < (off_t)sizeof(buffer) ? (size_t)remaining : sizeof(buffer);
    ssize_t count = pread(file->fd, buffer, requested, offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0 || CC_SHA256_Update(&hash, buffer, (CC_LONG)count) != 1)
      hold("protected hash read failed");
    offset += (off_t)count;
  }
  if (CC_SHA256_Final(digest, &hash) != 1) hold("protected hash final failed");
  for (size_t i = 0; i < sizeof(digest); ++i) {
    actual[2 * i] = hex[digest[i] >> 4];
    actual[2 * i + 1] = hex[digest[i] & 15];
  }
  actual[sizeof(actual) - 1] = '\0';
  struct stat after;
  if (strcmp(actual, expected) != 0 || fstat(file->fd, &after) != 0 ||
      !same_identity(&file->identity, &after)) hold("protected digest mismatch or drift");
}
#pragma clang diagnostic pop

static void require_native_signature(void) {
  /* Defense in depth AFTER startup; NEVER evidence of pre-main trust by itself.
   * The approved signing requirement must constrain signer AND identifier.
   * All entitlements are unnecessary for this consumer and are rejected. */
  SecCodeRef self = NULL;
  SecRequirementRef requirement = NULL;
  CFDictionaryRef information = NULL;
  CFURLRef origin = NULL;
  CFStringRef requirement_text = CFStringCreateWithCString(NULL, signing_requirement, kCFStringEncodingUTF8);
  if (requirement_text == NULL || SecRequirementCreateWithString(requirement_text,
      kSecCSDefaultFlags, &requirement) != errSecSuccess ||
      SecCodeCopySelf(kSecCSDefaultFlags, &self) != errSecSuccess ||
      SecCodeCheckValidity(self, kSecCSDefaultFlags, requirement) != errSecSuccess ||
      SecCodeCopySigningInformation((SecStaticCodeRef)self, kSecCSSigningInformation,
        &information) != errSecSuccess || information == NULL ||
      SecCodeCopyPath((SecStaticCodeRef)self, kSecCSDefaultFlags, &origin) != errSecSuccess ||
      origin == NULL) hold("native signing identity unavailable");
  unsigned char origin_path[PATH_MAX];
  if (!CFURLGetFileSystemRepresentation(origin, true, origin_path, sizeof(origin_path)) ||
      strcmp((const char *)origin_path, SUPERVISOR) != 0) hold("native origin is not fixed install");
  CFTypeRef flags_value = CFDictionaryGetValue(information, kSecCodeInfoFlags);
  int32_t flags = 0;
  const uint32_t required_flags = kSecCodeSignatureRuntime | kSecCodeSignatureLibraryValidation |
    kSecCodeSignatureForceHard | kSecCodeSignatureForceKill;
  if (flags_value == NULL || CFGetTypeID(flags_value) != CFNumberGetTypeID() ||
      !CFNumberGetValue((CFNumberRef)flags_value, kCFNumberSInt32Type, &flags) ||
      ((uint32_t)flags & required_flags) != required_flags ||
      ((uint32_t)flags & (kSecCodeSignatureAdhoc | kSecCodeSignatureLinkerSigned)) != 0)
    hold("native hardened signing flags missing");
  CFTypeRef entitlements = CFDictionaryGetValue(information, kSecCodeInfoEntitlementsDict);
  CFTypeRef raw_entitlements = CFDictionaryGetValue(information, kSecCodeInfoEntitlements);
  if ((entitlements != NULL && (CFGetTypeID(entitlements) != CFDictionaryGetTypeID() ||
      CFDictionaryGetCount((CFDictionaryRef)entitlements) != 0)) ||
      (raw_entitlements != NULL && entitlements == NULL)) hold("native entitlements unexpected");
  CFRelease(origin);
  CFRelease(information);
  CFRelease(self);
  CFRelease(requirement);
  CFRelease(requirement_text);
}

static void require_canonical_input_path(const char *value) {
  size_t length = value == NULL ? 0 : strnlen(value, PATH_MAX);
  if (length == 0 || length >= PATH_MAX || value[0] != '/' ||
      (length > 1 && value[length - 1] == '/')) hold("input path invalid");
  for (size_t i = 0; i < length; ++i)
    if ((unsigned char)value[i] < 0x20 || (unsigned char)value[i] == 0x7f)
      hold("input path contains control bytes");
  const char *part = value + 1;
  while (*part != '\0') {
    const char *end = strchr(part, '/');
    size_t count = end == NULL ? strlen(part) : (size_t)(end - part);
    if (count == 0 || (count == 1 && part[0] == '.') ||
        (count == 2 && part[0] == '.' && part[1] == '.')) hold("input path is not canonical");
    if (end == NULL) break;
    part = end + 1;
  }
  CFStringRef utf8 = CFStringCreateWithBytes(NULL, (const UInt8 *)value, (CFIndex)length,
    kCFStringEncodingUTF8, false);
  if (utf8 == NULL) hold("input path is not UTF-8");
  CFRelease(utf8);
}

static char *environment_entry(const char *key, const char *value) {
  size_t key_length = strlen(key), value_length = strlen(value);
  char *entry = malloc(key_length + value_length + 2);
  if (entry == NULL) hold("environment allocation failed");
  memcpy(entry, key, key_length);
  entry[key_length] = '=';
  memcpy(entry + key_length + 1, value, value_length + 1);
  return entry;
}

static char *current_home(void) {
  struct passwd record;
  struct passwd *result = NULL;
  char *buffer = malloc(PW_BUFFER_BYTES);
  if (buffer == NULL || getpwuid_r(getuid(), &record, buffer, PW_BUFFER_BYTES, &result) != 0 ||
      result == NULL || record.pw_uid != getuid() || record.pw_gid != getgid() || record.pw_dir == NULL)
    hold("current owner account unavailable");
  require_canonical_input_path(record.pw_dir);
  char physical[PATH_MAX];
  if (realpath(record.pw_dir, physical) == NULL || strcmp(physical, record.pw_dir) != 0)
    hold("current owner HOME is not physical");
  char *home = strdup(record.pw_dir);
  free(buffer);
  if (home == NULL) hold("HOME allocation failed");
  return home;
}

static void recheck_file(struct protected_file *first, size_t max_bytes, bool executable) {
  struct protected_file fresh = open_protected_file(first->path, max_bytes, executable, false);
  struct stat current;
  if (!same_identity(&first->identity, &fresh.identity) || fstat(first->fd, &current) != 0 ||
      !same_identity(&first->identity, &current)) hold("protected installation drift");
  (void)close(fresh.fd);
}

int main(int argc, char **argv) {
  /* No root launch, setuid/setgid behavior, selected user, selected binary, or
   * selected command. A protected owner is not a privileged executing owner. */
  if (getuid() == 0 || geteuid() == 0 || getuid() != geteuid() || getgid() != getegid())
    hold("requires the existing unprivileged owner identity");
  /* Clearing this here protects subsequent native-library work. It does not
   * sanitize the dynamic loader retroactively. Pre-main protection is external. */
  environ = empty_environment;
  (void)umask(0077);
  if (chdir("/") != 0) hold("cannot enter fixed cwd");
  /* Keep future protected descriptors out of slots 0..2 even if the caller
   * closed a standard stream. The child receives only deliberate stdio. */
  for (int fd = STDIN_FILENO; fd <= STDERR_FILENO; ++fd)
    if (fcntl(fd, F_GETFD) < 0) hold("standard stream unavailable");
  if (argc != 11 || argv[0] == NULL || strcmp(argv[0], SUPERVISOR) != 0 ||
      strcmp(argv[1], "--release-revision") != 0 ||
      strcmp(argv[3], "--run-id") != 0 || strcmp(argv[5], "--source-root") != 0 ||
      strcmp(argv[7], "--artifact-dir") != 0 || strcmp(argv[9], "--state-root") != 0 ||
      !lowercase_hex(expected_manifest, 64) || !lowercase_hex(expected_launcher, 64) ||
      sizeof(signing_requirement) <= 1 || sizeof(signing_requirement) > 4096 ||
      !lowercase_hex(argv[2], 40)) hold("fixed invocation or compiled pins invalid");
  size_t run_length = strnlen(argv[4], MAX_RUN_ID_BYTES + 1U);
  if (run_length == 0 || run_length > MAX_RUN_ID_BYTES || argv[4][0] < '1' || argv[4][0] > '9')
    hold("run id invalid");
  for (size_t i = 1; i < run_length; ++i)
    if (argv[4][i] < '0' || argv[4][i] > '9') hold("run id invalid");
  require_canonical_input_path(argv[6]);
  require_canonical_input_path(argv[8]);
  require_canonical_input_path(argv[10]);
  char *home = current_home();
  /* Exactly nine keys and one null terminator; no inherited additions. */
  char *clean_envp[] = {
    "PATH=/usr/bin:/bin", "LC_ALL=C", "LANG=C",
    environment_entry("HOME", home), environment_entry("SBW_RELEASE_REVISION", argv[2]),
    environment_entry("SBW_CONFORMANCE_RUN_ID", argv[4]),
    environment_entry("SBW_PUBLIC_SOURCE_ROOT", argv[6]),
    environment_entry("SBW_RUNTIME_ARTIFACT_DIR", argv[8]),
    environment_entry("SBW_STATE_ROOT", argv[10]), NULL
  };
  free(home);
  /* The origin/signature checks also occur after main; the independent install
   * receipt must already have established this image's startup trust. */
  struct protected_file native = open_protected_file(SUPERVISOR, MAX_NATIVE_BYTES, true, true);
  require_native_signature();
  struct protected_file manifest = open_protected_file(MANIFEST, MAX_MANIFEST_BYTES, false, true);
  struct protected_file launcher = open_protected_file(LAUNCHER, MAX_LAUNCHER_BYTES, true, true);
  struct protected_file shell = open_protected_file(SHELL, MAX_NATIVE_BYTES, true, true);
  require_digest(&manifest, expected_manifest);
  require_digest(&launcher, expected_launcher);

  posix_spawnattr_t attributes;
  posix_spawn_file_actions_t actions;
  sigset_t empty_mask, defaults;
  if (posix_spawnattr_init(&attributes) != 0 || posix_spawn_file_actions_init(&actions) != 0 ||
      sigemptyset(&empty_mask) != 0 || sigfillset(&defaults) != 0)
    hold("spawn initialization failed");
  /* SIGKILL/SIGSTOP cannot have dispositions; all other signals reset to normal. */
  if (sigdelset(&defaults, SIGKILL) != 0 || sigdelset(&defaults, SIGSTOP) != 0)
    hold("spawn signal set invalid");
  short flags = POSIX_SPAWN_SETEXEC | POSIX_SPAWN_CLOEXEC_DEFAULT |
    POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF;
  if (posix_spawnattr_setflags(&attributes, flags) != 0 ||
      posix_spawnattr_setsigmask(&attributes, &empty_mask) != 0 ||
      posix_spawnattr_setsigdefault(&attributes, &defaults) != 0 ||
      posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0) != 0 ||
      posix_spawn_file_actions_addinherit_np(&actions, STDOUT_FILENO) != 0 ||
      posix_spawn_file_actions_addinherit_np(&actions, STDERR_FILENO) != 0)
    hold("fixed spawn contract unavailable");
  recheck_file(&native, MAX_NATIVE_BYTES, true);
  recheck_file(&manifest, MAX_MANIFEST_BYTES, false);
  recheck_file(&launcher, MAX_LAUNCHER_BYTES, true);
  recheck_file(&shell, MAX_NATIVE_BYTES, true);
  require_native_signature();
  /* Root-managed installation must not change while this invocation is active.
   * Root/kernel compromise or a concurrent privileged replacement is outside
   * this unprivileged-threat contract; no absolute TOCTOU claim is made. */
  char *shell_argv[] = { SHELL, LAUNCHER, NULL };
  pid_t unused = -1;
  int result = posix_spawn(&unused, SHELL, &actions, &attributes, shell_argv, clean_envp);
  (void)result;
  /* Successful SETEXEC never returns; any return is HOLD. No receipt is emitted. */
  (void)posix_spawn_file_actions_destroy(&actions);
  (void)posix_spawnattr_destroy(&attributes);
  (void)close(native.fd);
  (void)close(manifest.fd);
  (void)close(launcher.fd);
  (void)close(shell.fd);
  for (size_t i = 3; i < 9; ++i) free(clean_envp[i]);
  hold("fixed shell replacement failed");
}

#include <grp.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/types.h>
#include <unistd.h>

extern char **environ;

static void json_string(const char *value) {
  putchar('"');
  for (const unsigned char *cursor = (const unsigned char *)value; *cursor != '\0'; cursor += 1) {
    switch (*cursor) {
      case '\\': fputs("\\\\", stdout); break;
      case '"': fputs("\\\"", stdout); break;
      case '\b': fputs("\\b", stdout); break;
      case '\f': fputs("\\f", stdout); break;
      case '\n': fputs("\\n", stdout); break;
      case '\r': fputs("\\r", stdout); break;
      case '\t': fputs("\\t", stdout); break;
      default:
        if (*cursor < 0x20) printf("\\u%04x", *cursor);
        else putchar((int)*cursor);
    }
  }
  putchar('"');
}

static void fail(const char *message) {
  fprintf(stderr, "host-execution-probe: %s\n", message);
}

int main(int argc, char **argv) {
  if (argc != 1) {
    fail("readiness probe does not accept arguments");
    return 126;
  }
  char cwd[PATH_MAX];
  if (getcwd(cwd, sizeof(cwd)) == NULL) {
    fail("cannot read the execution working directory");
    return 126;
  }
  int group_count = getgroups(0, NULL);
  if (group_count < 0) {
    fail("cannot read supplementary groups");
    return 126;
  }
  gid_t *groups = NULL;
  if (group_count > 0) {
    groups = calloc((size_t)group_count, sizeof(gid_t));
    if (groups == NULL || getgroups(group_count, groups) != group_count) {
      free(groups);
      fail("cannot read supplementary groups");
      return 126;
    }
  }
  fputs("{\"results\":[{\"id\":\"host-readiness-probe\",\"disposition\":\"NO_CHANGE\",\"passedAssertions\":[]}],\"probe\":{", stdout);
  printf("\"uid\":%u,\"euid\":%u,\"gid\":%u,\"egid\":%u,\"supplementaryGroups\":[",
         (unsigned int)getuid(), (unsigned int)geteuid(), (unsigned int)getgid(), (unsigned int)getegid());
  for (int index = 0; index < group_count; index += 1) {
    if (index > 0) putchar(',');
    printf("%u", (unsigned int)groups[index]);
  }
  fputs("],\"cwd\":", stdout);
  json_string(cwd);
  fputs(",\"argv0\":", stdout);
  json_string(argv[0]);
  fputs(",\"environment\":[", stdout);
  int first = 1;
  for (char **entry = environ; entry != NULL && *entry != NULL; entry += 1) {
    if (!first) putchar(',');
    first = 0;
    json_string(*entry);
  }
  fputs("]}}\n", stdout);
  free(groups);
  return 0;
}

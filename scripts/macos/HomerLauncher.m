#import <Foundation/Foundation.h>
#import <ServiceManagement/ServiceManagement.h>

#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static void print_usage(const char *argv0) {
  fprintf(
    stderr,
    "Usage:\n"
    "  %s <program> [args...]\n"
    "  %s --register-agent\n"
    "  %s --unregister-agent\n"
    "  %s --agent-status\n",
    argv0,
    argv0,
    argv0,
    argv0
  );
}

static const char *status_description(SMAppServiceStatus status) {
  switch (status) {
    case SMAppServiceStatusNotRegistered:
      return "not-registered";
    case SMAppServiceStatusEnabled:
      return "enabled";
    case SMAppServiceStatusRequiresApproval:
      return "requires-approval";
    case SMAppServiceStatusNotFound:
      return "not-found";
  }

  return "unknown";
}

static SMAppService *homer_agent_service(void) API_AVAILABLE(macos(13.0)) {
  return [SMAppService agentServiceWithPlistName:@"com.homer.daemon.plist"];
}

static void print_error_details(NSError *error) {
  if (error == nil) {
    return;
  }

  fprintf(
    stderr,
    "domain=%s code=%ld description=%s\n",
    error.domain.UTF8String,
    (long)error.code,
    error.localizedDescription.UTF8String
  );
}

static int register_agent(void) {
  if (@available(macOS 13.0, *)) {
    NSError *error = nil;
    SMAppService *service = homer_agent_service();

    if ([service registerAndReturnError:&error]) {
      printf("Registered embedded Homer LaunchAgent.\n");
      return 0;
    }

    fprintf(stderr, "Failed to register embedded Homer LaunchAgent.\n");
    print_error_details(error);
    return 1;
  }

  fprintf(stderr, "SMAppService requires macOS 13 or newer.\n");
  return 69;
}

static int unregister_agent(void) {
  if (@available(macOS 13.0, *)) {
    NSError *error = nil;
    SMAppService *service = homer_agent_service();

    if ([service unregisterAndReturnError:&error]) {
      printf("Unregistered embedded Homer LaunchAgent.\n");
      return 0;
    }

    fprintf(stderr, "Failed to unregister embedded Homer LaunchAgent.\n");
    print_error_details(error);
    return 1;
  }

  fprintf(stderr, "SMAppService requires macOS 13 or newer.\n");
  return 69;
}

static int print_agent_status(void) {
  if (@available(macOS 13.0, *)) {
    SMAppService *service = homer_agent_service();
    printf("SMAppService agent status: %s\n", status_description(service.status));
    return 0;
  }

  fprintf(stderr, "SMAppService requires macOS 13 or newer.\n");
  return 69;
}

static int exec_passthrough(int argc, char *argv[]) {
  if (argc < 2) {
    print_usage(argv[0]);
    return 64;
  }

  execv(argv[1], &argv[1]);

  fprintf(stderr, "Homer launcher failed to exec %s: %s\n", argv[1], strerror(errno));
  return errno ? errno : 111;
}

int main(int argc, char *argv[]) {
  @autoreleasepool {
    if (argc >= 2) {
      if (strcmp(argv[1], "--register-agent") == 0) {
        return register_agent();
      }
      if (strcmp(argv[1], "--unregister-agent") == 0) {
        return unregister_agent();
      }
      if (strcmp(argv[1], "--agent-status") == 0) {
        return print_agent_status();
      }
      if (strcmp(argv[1], "--help") == 0 || strcmp(argv[1], "-h") == 0) {
        print_usage(argv[0]);
        return 0;
      }
    }

    return exec_passthrough(argc, argv);
  }
}

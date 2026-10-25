// Read-only metadata. No NSApplication, AppleEvents, AX/UI scripting, event loop, activation,
// launch/open/show/focus, settings changes or fallback to another process.
#import <AppKit/NSWorkspace.h>
#import <AppKit/NSRunningApplication.h>
#import <Foundation/Foundation.h>
#include <unistd.h>
int main(void) {
 @autoreleasepool {
  NSRunningApplication *app=NSWorkspace.sharedWorkspace.frontmostApplication;
  if(!app || app.processIdentifier<=0 || app.processIdentifier==getpid() || !app.active || app.bundleIdentifier.length==0) {
   fputs("frontmost metadata unavailable\n",stderr);return 3;
  }
  NSDictionary *record=@{@"pid":@(app.processIdentifier),@"bundleId":app.bundleIdentifier,@"active":@YES};
  NSData *json=[NSJSONSerialization dataWithJSONObject:record options:0 error:nil];
  if(!json){fputs("frontmost metadata encoding failed\n",stderr);return 4;}
  fwrite(json.bytes,1,json.length,stdout);fputc('\n',stdout);return 0;
 }
}

#include <ApplicationServices/ApplicationServices.h>
#include <stdio.h>
#include <string.h>
int main(void){AEAddressDesc target={0};const char *id="com.apple.systemevents";OSStatus status=AECreateDesc(typeApplicationBundleID,id,strlen(id),&target);if(status==noErr){status=AEDeterminePermissionToAutomateTarget(&target,typeWildCard,typeWildCard,false);AEDisposeDesc(&target);}printf("%d\n",(int)status);return 0;}

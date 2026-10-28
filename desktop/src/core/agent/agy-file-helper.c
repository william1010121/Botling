// A capability rooted at a verified directory inode, never pathname check-then-open.
// No symlinks (even inside the workspace), special files or hardlinked files.
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
static void fail(void) { fputs("Workspace file access refused.\n", stderr); exit(1); }
static unsigned long long number(const char *s) { char *e; unsigned long long n=strtoull(s,&e,10); if(!*s||*e)fail(); return n; }
static int protected_fd(int fd, unsigned long long dev, unsigned long long ino) {
 struct stat st; if(fstat(fd,&st))fail(); return (unsigned long long)st.st_dev==dev && (unsigned long long)st.st_ino==ino;
}
int main(int argc,char **argv) {
 if(argc!=8)fail();
 int writing=!strcmp(argv[1],"write"); if(!writing&&strcmp(argv[1],"read"))fail();
 unsigned long long dev=number(argv[3]),ino=number(argv[4]),pd=number(argv[5]),pi=number(argv[6]);
 char *path=argv[7]; if(!*path||*path=='/'||strstr(path,"//")||path[strlen(path)-1]=='/')fail();
 int dir=open(argv[2],O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC); if(dir<0||!protected_fd(dir,dev,ino)||protected_fd(dir,pd,pi))fail();
 char *save=NULL,*part=strtok_r(path,"/",&save); int fd=-1;
 while(part){
  if(!strcmp(part,".")||!strcmp(part,".."))fail();
  char *next=strtok_r(NULL,"/",&save);
  if(next){int child=openat(dir,part,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);if(child<0||protected_fd(child,pd,pi))fail();close(dir);dir=child;}
  else {
   fd=openat(dir,part,(writing?O_WRONLY:O_RDONLY)|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC);
   if(fd<0&&writing&&errno==ENOENT)fd=openat(dir,part,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600);
   if(fd<0)fail();
  }
  part=next;
 }
 close(dir);struct stat st;if(fd<0||fstat(fd,&st)||!S_ISREG(st.st_mode)||st.st_nlink!=1||protected_fd(fd,pd,pi))fail();
 char buffer[16384];ssize_t n;size_t total=0;
 if(writing){
  // Read and bound all input before modifying an existing file.
  char *content=malloc(2000001);if(!content)fail();
  while((n=read(STDIN_FILENO,content+total,2000001-total))>0){total+=(size_t)n;if(total>2000000)fail();}
  if(n<0||ftruncate(fd,0))fail();size_t at=0;
  while(at<total){n=write(fd,content+at,total-at);if(n<=0)fail();at+=(size_t)n;}free(content);
 }else{
  if(st.st_size>2000000)fail();
  while((n=read(fd,buffer,sizeof buffer))>0){total+=(size_t)n;if(total>2000000)fail();ssize_t at=0;while(at<n){ssize_t m=write(STDOUT_FILENO,buffer+at,(size_t)(n-at));if(m<=0)fail();at+=m;}}
  if(n<0)fail();
 }
 if(close(fd))fail();return 0;
}

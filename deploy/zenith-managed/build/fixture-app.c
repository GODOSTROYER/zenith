/* Disposable non-root kind fixture: static C, no credentials or cloud calls. */
#include <arpa/inet.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>
int main(int argc, char **argv) {
 if(argc>1 && strcmp(argv[1],"migrate")==0){ puts("zenith-j6-fixture-command-complete"); return 0; }
 int server=socket(AF_INET,SOCK_STREAM,0),one=1;
 if(server<0)return 1;
 setsockopt(server,SOL_SOCKET,SO_REUSEADDR,&one,sizeof(one));
 struct sockaddr_in address={.sin_family=AF_INET,.sin_port=htons(8080),.sin_addr={.s_addr=INADDR_ANY}};
 if(bind(server,(struct sockaddr*)&address,sizeof(address))!=0 || listen(server,8)!=0)return 1;
 for(;;){
  int client=accept(server,0,0);if(client<0)return 1;
  char request[1024]; if(read(client,request,sizeof(request))>0){
   const char response[]="HTTP/1.1 200 OK\r\nContent-Length: 25\r\nConnection: close\r\n\r\nzenith-j6-source-release\n";
   if(write(client,response,sizeof(response)-1)<0){close(client);continue;}
  }
  close(client);
 }
}


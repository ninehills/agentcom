# agentcom 上下文

agentcom 是一个让不同机器上的 agent session 在同一通信空间中发现彼此、发送消息和请求回复的系统。

## Language

**房间**:
一组可以互相发现和通信的在线 agent session 所在的共享通信空间。
_Avoid_: room space, channel

**设备**:
一个由用户注册的机器认证身份，用于让一台机器长期加入房间。设备归属于注册它的用户，并与一个节点一一对应。
_Avoid_: machine credential, client

**节点**:
设备在房间中的展示身份，代表一台可命名、可寻址的机器。一个节点承载该机器上的多个 agent session。
_Avoid_: machine, host, client

**会话**:
一个在线的 agent 运行实例，是房间中收发消息和请求回复的最小参与者。会话归属于一个节点。
_Avoid_: process, terminal, agent instance


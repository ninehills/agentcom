# pi-agentcom

Remote Pi session communication over an AgentCom WebSocket server.

## Install

```bash
pi install npm:@agentcom/pi-agentcom
```

Then restart Pi or run `/reload`.

## Configure

Create a device token from your AgentCom Worker UI, then join from Pi:

```text
/com join wss://<your-agentcom-worker>/ws <device-token>
```

The extension stores credentials locally and reconnects automatically on startup.

## Commands

```text
/com auth                         open/save auth URL helper
/com join <ws_url> <device_token> join a room
/com list                         list online sessions
/com send <target> <message>      send a message
/com ask <target> <message>       ask and wait for a reply
/com reply <message>              reply to a pending ask
/com pending                      show pending asks
/com status                       show connection status
/com rename <node_name>           rename current node
/com leave                        disconnect and remove current credential
```

The package also registers the `com` tool for agents.

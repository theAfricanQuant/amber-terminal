# Deployment notes

Amber Terminal is configured for one local user. The server binds to `127.0.0.1` by default, and saved layout and portfolio state are shared in the local `data/` directory.

Do not expose this app directly to the public internet. The server includes endpoints that write custom JavaScript files and loads those files into the running app. A public deployment needs authentication and authorization on every route, removal or isolation of code-writing features, and separate state for each user before it is safe to offer to multiple users.

For private use on a Hetzner server, keep it bound to localhost and reach it through a VPN or SSH tunnel. The GitHub repository contains the application source; it is not a multi-user hosted service.

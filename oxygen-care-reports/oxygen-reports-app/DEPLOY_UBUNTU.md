# Ubuntu Server deployment

This project is a Next.js 16 TypeScript application using npm.

- Required Node.js: 20 or newer (your server’s Node 22.22.1 is suitable)
- Install command: `npm ci`
- Build command: `npm run build`
- Production start: `npm run start -- -H 127.0.0.1 -p 3000`

## Deploy from the Mac

1. Open Terminal in this project folder.
2. Run `chmod +x deploy-ubuntu.sh` once.
3. Run `./deploy-ubuntu.sh`.
4. Enter the server administrator password only when Ubuntu requests it.
5. Open `http://192.168.0.248` after the script reports success.

The script transfers source code only, installs dependencies on the server, builds there, creates a protected `oxygenreports` service account, and runs the app through systemd. Next.js listens only on `127.0.0.1:3000`; Nginx is the only public entry point. UFW is configured with the `Nginx Full` profile (ports 80 and 443). It does not open PostgreSQL, port 3000, or any development port.

## HTTPS

An IP address cannot receive a normal Let’s Encrypt certificate. After you point a DNS name at the server, run on Ubuntu:

```bash
sudo apt-get install certbot python3-certbot-nginx
sudo certbot --nginx -d reports.example.com
```

Replace `reports.example.com` with your real hostname. Certbot will add the HTTPS Nginx configuration and renewal timer.

## Environment variables

The current demo does not use a database or external secrets. Its production environment file contains only `NODE_ENV`, `PORT`, and `HOSTNAME` and is stored at `/etc/oxygen-care-reports/oxygen-care-reports.env` with restricted permissions.

When the future server-backed package is deployed, add its database, storage, mail, session, and MFA values to this protected environment file—never to source files or the public Nginx configuration.

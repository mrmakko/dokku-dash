# Dokku Dashboard

## Purpose
A lightweight dashboard for monitoring and accessing all pet projects deployed on a Dokku VDS server. Provides a quick overview of deployed apps, their running status, and direct links.

## Key Features
- **Authentication**: Simple password-based login (single shared password)
- **App Listing**: Displays all Dokku apps deployed on the server
- **Status Monitoring**: Shows running/stopped status for each app
- **Auto-refresh**: Dashboard refreshes every 30 seconds
- **Direct Links**: Quick access to each app via its URL

## How It Works
1. Express.js server running on Dokku
2. Reads app data from `/home/dokku/` directory on the server
3. Queries Docker API to get container status
4. Frontend fetches `/api/apps` to display projects
5. Session-based authentication with password verification

## Architecture
- **Backend**: Node.js + Express
- **Frontend**: Vanilla HTML/CSS/JavaScript
- **Auth**: Express sessions with password protection
- **Deployment**: Dokku (git push to deploy)

## Environment Variables
- `DASHBOARD_PASSWORD`: Login password (default: "changeme")
- `PORT`: Server port (default: 5000)

## File Structure
```
├── index.js              # Express server + API routes
├── package.json          # Dependencies
├── Procfile             # Dokku process definition
├── app.json             # Dokku configuration
├── .gitignore
└── public/
    ├── login.html       # Login page
    └── dashboard.html   # Projects dashboard
```

## Deployment
Deploy to Dokku from local machine:
```bash
git remote add dokku dokku@perf-vds:dashboard
git push dokku master
dokku@perf-vds config:set dashboard DASHBOARD_PASSWORD="yourpassword"
dokku@perf-vds domains:add dashboard dashboard.perf-vds
```

## Future Enhancements (if needed)
- Add logs viewer
- Show app creation/deployment dates
- Display resource usage (memory, CPU)
- Webhook for real-time status updates
- Multiple user accounts with different permissions

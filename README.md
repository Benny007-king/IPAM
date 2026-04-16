# 🚀 IPAM System

A professional, real-time IP Address Management (IPAM) solution built with React, Node.js, Express, and SQLite. Track, manage, and monitor IP allocations across multiple network segments with an active background service that automatically alerts you when hosts go offline.

---

## ✨ Key Features

* **🗄️ Network Segmentation:** Easily create subnets and segments. The system automatically populates valid IP addresses based on the network and subnet mask.
* **📡 Active Monitoring:** Background service continually pings all IPs. If a host goes offline, the system triggers alerts based on configurable thresholds (5 mins, 24 hours, etc.).
* **🔐 LDAP & Active Directory Integration:** Authenticate via local accounts or integrate with multiple LDAP/AD servers, mapping AD groups to system roles.
* **🛡️ Role-Based Access Control (RBAC):** Three distinct roles (`admin`, `editor`, `readonly`) to securely manage network documentation.
* **⚡ Smart Search:** Lightning-fast global search to find any IP, hostname, or segment instantly.
* **📊 Export Options:** Export segment data to PDF or Excel (XLSX) with a single click.
* **🔔 Notification Center:** Built-in alerts with "Mute IP" and "Mark as read" capabilities.

---

## 🛠️ Tech Stack

* **Frontend:** React 19, TypeScript, Vite, Tailwind CSS, Lucide Icons.
* **Backend:** Node.js, Express, TypeScript.
* **Database:** SQLite (using `better-sqlite3` with WAL mode for high concurrency).
* **Authentication:** JWT (JSON Web Tokens) & `ldapts` for AD integration.
* **Utilities:** `ping` (ICMP checks), `date-fns`.

---

## 🐳 Docker Deployment (Recommended)

Running the application via Docker ensures isolated execution and handles all system dependencies (like ping utilities) automatically.

### 1. Create a `Dockerfile`
Create a file named `Dockerfile` in the root directory:

```dockerfile
# Use an official Node.js image
FROM node:20

# Set the working directory inside the container
WORKDIR /app

# Install ping utility required for network monitoring
RUN apt-get update && apt-get install -y iputils-ping && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# Build the React frontend
RUN npm run build

# Set environment variables
ENV NODE_ENV=production

# Expose the port the app runs on
EXPOSE 3000

# Command to run the server
CMD ["npx", "tsx", "server.ts", "--prod"]
2. Create a .dockerignore
Create a .dockerignore file in the root directory to keep the container lightweight and prevent overriding the container's database with your local development DB:

Plaintext
node_modules
dist
.env
*.db
*.db-wal
*.db-shm
3. Run the Application
Open your terminal in the project folder, build the image, and run the container.
(Note: --cap-add=NET_RAW is required so the container has permission to send ICMP Ping packets to monitor IP status).

Bash
# Build the image
docker build -t ipam-app .

# Run the container with a persistent volume
docker run -d --name ipam-server --cap-add=NET_RAW -p 3000:3000 -v ipam_data:/app ipam-app
Access the app at http://localhost:3000. Your database will be persistently saved in the Docker volume named ipam_data.

💻 Local Installation (Without Docker)
If you prefer to run the application directly on your machine:

Install dependencies:

Bash
npm install
Build the frontend:

Bash
npm run build
Start the server in production mode:

Bash
npx tsx server.ts --prod
(Windows users can also use the included build_and_start.bat script).

⚙️ Initial Setup
Default Login: Use admin / admin123.

Security: Change the admin password immediately in the Settings tab after your first login.

LDAP Configuration: Go to Settings -> LDAP Servers to add your Active Directory details, then map your AD groups to IPAM roles in the AD Groups tab.

📁 Project Structure
server.ts – Backend Express server, API endpoints, and authentication logic.

pingService.ts – Background service handling ICMP pings and offline notifications.

database.ts – SQLite table schemas and automatic migrations.

src/App.tsx – Main frontend UI, context providers, and routing.

src/SettingsView.tsx – Settings dashboard for user and LDAP management.

Developed by Benny | Optimized for internal infrastructure and IP address management.

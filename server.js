const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    status: "OK",
    service: "Phone Repair Backend",
    time: new Date().toISOString(),
    connections: {
      dashboards: dashboards.size,
      customers: customers.size
    }
  });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN;

if (!DASHBOARD_TOKEN) {
  throw new Error("⚠️  DASHBOARD_TOKEN is not set");
}

// Store connections
const dashboards = new Set();
const customers = new Map(); // Map of sessionId -> customer connection

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get("token");
  const sessionId = url.searchParams.get("sessionId");
  const type = url.searchParams.get("type"); // 'dashboard' or 'customer'

  // ===== CUSTOMER CONNECTION (CHECK FIRST!) =====
  if (type === "customer" && sessionId) {
    const customerId = sessionId;
    
    customers.set(customerId, {
      ws,
      sessionId: customerId,
      name: `Customer-${customerId.slice(0, 6)}`,
      permissions: new Set(),
      connectedAt: new Date()
    });

    console.log(`👤 Customer connected: ${customerId} (${customers.size} total)`);

    // Notify all dashboards
    broadcast(dashboards, {
      type: "device_connected",
      device: {
        id: customerId,
        name: `Customer-${customerId.slice(0, 6)}`,
        status: "online"
      }
    });

    ws.on("message", (message) => {
      try {
        const data = JSON.parse(message.toString());
        console.log(`📥 Customer ${customerId} message:`, data);

        // Handle customer messages
        if (data.type === "permission_granted") {
          const customer = customers.get(customerId);
          if (customer) {
            customer.permissions.add(data.permission);
          }
          
          // Notify dashboards
          broadcast(dashboards, {
            type: "permission_granted",
            deviceId: customerId,
            permission: data.permission
          });
        } else if (data.type === "consent_signed") {
          broadcast(dashboards, {
            type: "consent_signed",
            deviceId: customerId,
            timestamp: new Date().toISOString()
          });
        } else if (data.type === "reaction_time") {
          console.log(`⏱️  Customer ${customerId} reaction time: ${data.reactionTime}ms`);
          broadcast(dashboards, {
            type: "reaction_time",
            deviceId: customerId,
            reactionTime: data.reactionTime,
            timestamp: data.timestamp
          });
        } else if (data.type === "consent_response") {
          console.log(`📝 Customer ${customerId} consent: ${data.accepted ? 'ACCEPTED' : 'REJECTED'}`);
          broadcast(dashboards, {
            type: "consent_response",
            deviceId: customerId,
            accepted: data.accepted,
            reactionTime: data.reactionTime,
            timestamp: data.timestamp
          });
        }
      } catch (err) {
        console.error("Error parsing customer message:", err);
      }
    });

    ws.on("close", () => {
      customers.delete(customerId);
      console.log(`👤 Customer disconnected: ${customerId} (${customers.size} remaining)`);

      // Notify dashboards
      broadcast(dashboards, {
        type: "device_disconnected",
        deviceId: customerId
      });
    });

    // Send welcome message
    ws.send(JSON.stringify({
      type: "connected",
      sessionId: customerId,
      message: "Connected to repair service"
    }));

    return;
  }

  // ===== DASHBOARD CONNECTION =====
  if (token === DASHBOARD_TOKEN) {
    dashboards.add(ws);
    console.log(`✅ Dashboard connected (${dashboards.size} total)`);

    ws.on("message", (message) => {
      try {
        const data = JSON.parse(message.toString());
        console.log("📥 Dashboard command:", data);

        // Handle different commands
        if (data.action === "start_session") {
          handleStartSession(data, ws);
        } else if (data.action === "stop_session") {
          handleStopSession(data, ws);
        } else if (data.action === "permission") {
          handlePermissionToggle(data, ws);
        } else if (data.command) {
          // Legacy command format
          broadcast(dashboards, {
            type: "command_received",
            command: data.command,
            timestamp: new Date().toISOString()
          });
        }
      } catch (err) {
        console.error("Error parsing dashboard message:", err);
      }
    });

    ws.on("close", () => {
      dashboards.delete(ws);
      console.log(`Dashboard disconnected (${dashboards.size} remaining)`);
    });

    // Send current customer list
    ws.send(JSON.stringify({
      type: "devices_list",
      devices: Array.from(customers.entries()).map(([id, data]) => ({
        id,
        name: data.name || id,
        status: "online"
      }))
    }));

    return;
  }

  // ===== UNAUTHORIZED =====
  ws.close(1008, "Unauthorized");
  console.log("❌ Rejected unauthorized connection");
});

// ===== HELPER FUNCTIONS =====

function handleStartSession(data, dashboardWs) {
  const customerId = data.device;
  const customer = customers.get(customerId);

  if (customer) {
    console.log(`🚀 Starting session for customer: ${customerId}`);
    console.log(`   Permissions requested: ${data.permissions.join(", ")}`);

    // Send to customer
    customer.ws.send(JSON.stringify({
      type: "session_started",
      permissions: data.permissions,
      message: "Technician has started the repair session"
    }));

    // Confirm to dashboard
    dashboardWs.send(JSON.stringify({
      type: "session_update",
      status: "Active",
      deviceId: customerId
    }));
  }
}

function handleStopSession(data, dashboardWs) {
  const customerId = data.device;
  const customer = customers.get(customerId);

  if (customer) {
    console.log(`🛑 Stopping session for customer: ${customerId}`);

    // Send to customer
    customer.ws.send(JSON.stringify({
      type: "session_stopped",
      message: "Technician has ended the repair session"
    }));

    // Confirm to dashboard
    dashboardWs.send(JSON.stringify({
      type: "session_update",
      status: "Stopped",
      deviceId: customerId
    }));
  }
}

function handlePermissionToggle(data, dashboardWs) {
  console.log(`🔑 Permission ${data.enabled ? 'enabled' : 'disabled'}: ${data.permission}`);
  
  // You can track this or send to customer if needed
  broadcast(dashboards, {
    type: "permission_toggled",
    permission: data.permission,
    enabled: data.enabled
  });
}

function broadcast(connections, message) {
  const data = JSON.stringify(message);
  connections.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

// ===== SERVER START =====
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log("╔════════════════════════════════════════╗");
  console.log("║   Phone Repair Backend Server         ║");
  console.log("╠════════════════════════════════════════╣");
  console.log(`║   Port: ${PORT.toString().padEnd(30)} ║`);
  console.log(`║   Status: Running                      ║`);
  console.log("╚════════════════════════════════════════╝");
});

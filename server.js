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
    service: "ig-app-backend",
    time: new Date().toISOString()
  });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || "DASHBOARD_SECRET_A12c2611.2001";

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get("token");


  if (token !== DASHBOARD_TOKEN) {
    ws.close(1008, "Unauthorized");
    console.log("❌ Rejected unauthorized connection");
    return;
  }

  console.log("✅ Dashboard connected");

  ws.on("message", (message) => {
    const data = JSON.parse(message.toString());

    const response = {
      message: `Command "${data.command}" accepted`,
      status: "Active"
    };

    ws.send(JSON.stringify(response));
  });

  ws.on("close", () => {
    console.log("Dashboard disconnected");
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

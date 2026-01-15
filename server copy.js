const express = require("express");
const redis = require("redis");
require("dotenv").config();

const app = express();
app.use(express.json());

// Redis Client
const redisClient = redis.createClient({
  socket: {
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT
  }
});

redisClient.on("connect", () => console.log("✅ Redis connected"));
redisClient.on("error", (err) => console.error("❌ Redis error:", err));

(async () => { await redisClient.connect(); })();

// Make Redis accessible in request handlers
app.locals.redisClient = redisClient;

// Routes
const webhookRoutes = require("./routes/webhook");
const redisRoutes = require("./routes/redisRoutes");

app.use("/webhook", webhookRoutes);
app.use("/redis", redisRoutes);

// Health check
app.get("/", (req, res) => {
  res.json({ status: "Server running", agency: process.env.AGENCY });
});

// Start server
app.listen(process.env.PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${process.env.PORT}`);
});

require("dotenv").config();  // Load .env variables
const express = require("express");
const redis = require("redis");
const chatRoutes = require("./chat"); // chat module index.js

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Redis client
const redisClient = redis.createClient({
  socket: { 
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT
  }
});

redisClient.connect().then(() => console.log("Redis connected"))
  .catch(err => console.error(err));

// Make Redis accessible to modules
app.locals.redis = redisClient;

// Health check
app.get("/", (req, res) => res.json({ status: "Server running" }));

// Mount chat routes
app.use("/chat", chatRoutes);

app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));

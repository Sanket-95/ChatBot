require("dotenv").config();           // Load .env
const express = require("express");
const redis = require("redis");
const chatRoutes = require("./chat"); // chat module

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 4000;

// Create Redis client
const redisClient = redis.createClient({
  socket: {
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT
  }
});

// Global Redis reference for modules
app.locals.redis = redisClient;

// Connect Redis before starting server
(async () => {
  try {
    await redisClient.connect();
    console.log("Redis connected");

    // Test route
    app.get("/test", (req, res) => {
      res.json({ message: "Server responding!" });
    });

    // Mount chat module
    app.use("/chat", chatRoutes);

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on port ${PORT}`);
    });

  } catch (err) {
    console.error("Redis connection failed:", err);
  }
})();

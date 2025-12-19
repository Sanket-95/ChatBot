const redis = require("redis");

const client = redis.createClient({
  socket: {
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT
  }
});

client.connect();

async function hasSession(mobile) {
  return await client.exists(mobile);
}

async function createSession(mobile) {
  await client.setEx(mobile, process.env.REDIS_TTL, "active");
}

module.exports = { hasSession, createSession };

require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const { handleIncomingMessage } = require("./logic/messageFlow");

const app = express();
app.use(bodyParser.json());

app.get("/webhook", (req, res) => {
  if (
    req.query["hub.mode"] === "subscribe" &&
    req.query["hub.verify_token"] === process.env.VERIFY_TOKEN
  ) {
    return res.status(200).send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  const message =
    req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

  if (!message) return res.sendStatus(200);

  const mobile = message.from;
  const text = message.text?.body || "";

  console.log("📲 Message received from:", mobile);

  await handleIncomingMessage(mobile, text);
  res.sendStatus(200);
});

app.listen(process.env.PORT, () => {
  console.log(`🚀 Webhook running on port ${process.env.PORT}`);
});

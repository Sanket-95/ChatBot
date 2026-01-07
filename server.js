const express = require("express");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(express.json());

const PORT = 4000;

// Send WhatsApp message
app.post("/send", async (req, res) => {
  const { mobile } = req.body;

  try {
    const response = await axios.post(
      `https://graph.facebook.com/v22.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: mobile,
        type: "text",
        text: {
          body: `Hello ${mobile}`
        }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    res.status(200).json({
      status: "success",
      data: response.data
    });

  } catch (error) {
    res.status(500).json({
      status: "error",
      message: error.response?.data || error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

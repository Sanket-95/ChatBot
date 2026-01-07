const express = require("express");
const router = express.Router();
const chatRoutes = require("./chatRoutes");

// Mount chat routes
router.use("/", chatRoutes);

module.exports = router;

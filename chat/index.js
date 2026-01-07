const express = require("express");
const router = express.Router();

// Import chat routes from separate file (optional if you want more separation)
const chatRoutes = require("./chatRoutes");

// Mount chat routes
router.use("/", chatRoutes);

module.exports = router;

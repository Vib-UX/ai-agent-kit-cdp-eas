const express = require("express");
const multer = require("multer");
const axios = require("axios");
const fs = require("fs");
const router = express.Router();

// Configure multer for image upload
const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 5 * 1024 * 1024 }, // Limit to 5MB
});

// API Endpoint to process images
router.post("/process-image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No image file uploaded." });
    }

    const imagePath = req.file.path;

    // Convert the image file to a base64 string
    const imageBuffer = fs.readFileSync(imagePath);
    const base64Image = imageBuffer.toString("base64");

    // OpenAI API request
    const response = await axios.post(
      "https://api.openai.com/v1/images/generate",
      {
        prompt: "Describe the event depicted in this image.",
        image: base64Image,
        max_tokens: 300,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const description =
      response.data.choices[0]?.text || "No description generated.";

    // Send the processed response
    res.status(200).json({
      event_name: "AI-generated Event",
      event_description: description.trim(),
      description: description.trim(),
    });
  } catch (error) {
    console.error(
      "Error processing image:",
      error.response?.data || error.message
    );
    res
      .status(500)
      .json({ error: "Failed to process image", details: error.message });
  } finally {
    // Clean up uploaded file
    if (req.file) {
      fs.unlinkSync(req.file.path);
    }
  }
});

module.exports = router;

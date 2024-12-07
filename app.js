import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import cors from "cors";
import FormData from "form-data";
import axios from "axios";
import { OpenAI } from "openai";
import { EAS, SchemaEncoder } from "@ethereum-attestation-service/eas-sdk";
import { ethers } from "ethers";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
const PORT = process.env.PORT || 3000;

// Configure multer for file uploads
const upload = multer({
  dest: path.resolve("uploads"),
});

const JWT = process.env.PINATA_JWT;
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// EAS Configuration
const easContractAddress = "0x4200000000000000000000000000000000000021";
const schemaUID =
  "0x0ab02d640f0bb27a4b16a89bb51e53fbe1693647bcb02048650d32a7d6cc8d40";
const eas = new EAS(easContractAddress);

// Function to pin a file to IPFS
const pinFileToIPFS = async (filePath, fileName) => {
  try {
    const formData = new FormData();
    const file = fs.createReadStream(filePath);
    formData.append("file", file);
    formData.append("pinataMetadata", JSON.stringify({ name: fileName }));
    formData.append("pinataOptions", JSON.stringify({ cidVersion: 0 }));

    const response = await axios.post(
      "https://api.pinata.cloud/pinning/pinFileToIPFS",
      formData,
      {
        headers: {
          ...formData.getHeaders(),
          Authorization: `Bearer ${JWT}`,
        },
      }
    );

    return `https://violet-gentle-cow-510.mypinata.cloud/ipfs/${response.data.IpfsHash}`;
  } catch (error) {
    console.error("Error in pinFileToIPFS:", error);
    throw error;
  }
};

// Function to parse AI response
const parseAIResponse = (responseText) => {
  const defaultValues = {
    event_name: "Untitled Event",
    event_description: "No description provided.",
    occasion: "Unknown",
    location_coordinates: ["0.0", "0.0"], // Default if not provided
    memory_description: "No memory description provided.",
  };

  try {
    console.log("Raw AI Response Text:", responseText);

    const lines = responseText.split("\n").map((line) => line.trim());
    const data = {};

    lines.forEach((line) => {
      if (line.startsWith("Event Name:")) {
        data.event_name = line.replace("Event Name:", "").trim();
      } else if (line.startsWith("Event Description:")) {
        data.event_description = line.replace("Event Description:", "").trim();
      } else if (line.startsWith("Occasion:")) {
        data.occasion = line.replace("Occasion:", "").trim();
      }
    });

    return {
      event_name: data.event_name || defaultValues.event_name,
      event_description:
        data.event_description || defaultValues.event_description,
      occasion: data.occasion || defaultValues.occasion,
      location_coordinates: defaultValues.location_coordinates,
      memory_description: "Generated from OpenAI analysis of the image.",
    };
  } catch (error) {
    console.error("Error parsing AI response:", error);
    return defaultValues;
  }
};

// Endpoint to upload image
app.post("/upload-image", upload.single("image"), async (req, res) => {
  const { file } = req;
  const { location_coordinates, recipient } = req.body;

  if (!file) {
    return res
      .status(400)
      .json({ success: false, message: "No file uploaded." });
  }

  try {
    console.log(`Received file: ${file.originalname}`);
    const parsedCoordinates = JSON.parse(location_coordinates);

    console.log(`Pinning file to IPFS...`);
    const ipfsUrl = await pinFileToIPFS(file.path, file.originalname);
    console.log(`File pinned to IPFS at: ${ipfsUrl}`);

    console.log(`Sending IPFS URL to OpenAI for description...`);
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Analyze this image and try to extract the following information: Event Name, Event Description, Occasion.",
            },
            {
              type: "image_url",
              image_url: { url: ipfsUrl },
            },
          ],
        },
      ],
    });

    const responseText =
      completion.choices[0]?.message?.content ||
      '{"error": "No description generated."}';
    console.log("AI Response Text:", responseText);

    const schemaValues = parseAIResponse(responseText);
    schemaValues.location_coordinates = parsedCoordinates;

    console.log("Creating attestation...");
    const provider = new ethers.JsonRpcProvider("https://sepolia.base.org");
    const signer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

    await eas.connect(signer);

    const schemaEncoder = new SchemaEncoder(
      "string event_name,string event_description,string occassion,string[] location_coordinates,string memory_description"
    );

    const encodedData = schemaEncoder.encodeData([
      { name: "event_name", value: schemaValues.event_name, type: "string" },
      {
        name: "event_description",
        value: schemaValues.event_description,
        type: "string",
      },
      { name: "occassion", value: schemaValues.occasion, type: "string" },
      {
        name: "location_coordinates",
        value: schemaValues.location_coordinates,
        type: "string[]",
      },
      {
        name: "memory_description",
        value: schemaValues.memory_description,
        type: "string",
      },
    ]);

    const tx = await eas.attest({
      schema: schemaUID,
      data: {
        recipient,
        expirationTime: 0,
        revocable: true,
        data: encodedData,
      },
    });

    const newAttestationUID = await tx.wait();
    console.log("New attestation UID:", newAttestationUID);

    fs.unlinkSync(file.path);

    res.status(200).json({
      success: true,
      message: "Image uploaded, pinned, described, and attested successfully.",
      ipfsUrl,
      schemaValues,
      attestationUID: newAttestationUID,
    });
  } catch (err) {
    console.error("Error in /upload-image:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

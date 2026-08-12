const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.GEMINI_API_KEY;

const jobs = new Map();
const imageJobs = new Map();

const indexPath = path.join(__dirname, "index.html");

function send(res, status, data, type = "application/json") {
  res.writeHead(status, {
    "Content-Type": type,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  });

  res.end(
    type === "application/json"
      ? JSON.stringify(data)
      : data
  );
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", chunk => {
      body += chunk;

      if (body.length > 5 * 1024 * 1024) {
        reject(new Error("Request too large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });

    req.on("error", reject);
  });
}


/* =========================
   TEXT GENERATION
========================= */

async function generateWithGemini(prompt) {

  if (!API_KEY) {
    throw new Error(
      "GEMINI_API_KEY is not configured in Render"
    );
  }

  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent",
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": API_KEY
      },

      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: prompt
              }
            ]
          }
        ]
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data?.error?.message ||
      "Gemini API request failed"
    );
  }

  return (
    data?.candidates?.[0]
      ?.content?.parts?.[0]?.text ||
    "Gemini returned no text."
  );
}


function startTextJob(jobId, prompt) {

  setTimeout(async () => {

    const job = jobs.get(jobId);

    if (!job) return;

    job.status = "processing";
    jobs.set(jobId, job);

    try {

      const generatedText =
        await generateWithGemini(prompt);

      job.status = "completed";
      job.generatedText = generatedText;
      job.videoUrl = null;

      jobs.set(jobId, job);

    } catch (error) {

      console.error(
        "Gemini text error:",
        error
      );

      job.status = "failed";
      job.error = error.message;

      jobs.set(jobId, job);
    }

  }, 500);
}


/* =========================
   IMAGE GENERATION
   NANO BANANA / GEMINI IMAGE
========================= */

async function generateImage(
  prompt,
  aspectRatio
) {

  if (!API_KEY) {
    throw new Error(
      "GEMINI_API_KEY is not configured in Render"
    );
  }

  const ratio =
    aspectRatio === "16:9"
      ? "16:9"
      : aspectRatio === "1:1"
      ? "1:1"
      : "9:16";

  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent",
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": API_KEY
      },

      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: prompt
              }
            ]
          }
        ],

        generationConfig: {
          responseModalities: [
            "TEXT",
            "IMAGE"
          ],

          responseFormat: {
            image: {
              aspectRatio: ratio,
              imageSize: "1K"
            }
          }
        }
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data?.error?.message ||
      "Image generation failed"
    );
  }

  const parts =
    data?.candidates?.[0]
      ?.content?.parts || [];

  const imagePart =
    parts.find(
      part =>
        part.inlineData ||
        part.inline_data
    );

  if (!imagePart) {
    throw new Error(
      "Image was not returned by Gemini"
    );
  }

  const imageData =
    imagePart.inlineData ||
    imagePart.inline_data;

  const mimeType =
    imageData.mimeType ||
    imageData.mime_type ||
    "image/png";

  const base64 =
    imageData.data;

  if (!base64) {
    throw new Error(
      "Image data is empty"
    );
  }

  return {
    base64,
    mimeType
  };
}


/* =========================
   IMAGE JOB
========================= */

async function startImageJob(
  jobId,
  prompt,
  aspectRatio
) {

  setTimeout(async () => {

    const job =
      imageJobs.get(jobId);

    if (!job) return;

    job.status = "processing";
    job.message =
      "Nano Banana is generating your image...";

    imageJobs.set(jobId, job);

    try {

      const result =
        await generateImage(
          prompt,
          aspectRatio
        );

      job.status = "completed";

      job.message =
        "Image generation completed ✓";

      job.imageUrl =
        "data:" +
        result.mimeType +
        ";base64," +
        result.base64;

      imageJobs.set(jobId, job);

    } catch (error) {

      console.error(
        "Image generation error:",
        error
      );

      job.status = "failed";
      job.error = error.message;

      imageJobs.set(jobId, job);
    }

  }, 300);
}


/* =========================
   SERVER
========================= */

const server =
  http.createServer(
    async (req, res) => {

      /* CORS */

      if (req.method === "OPTIONS") {

        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers":
            "Content-Type",
          "Access-Control-Allow-Methods":
            "GET,POST,OPTIONS"
        });

        return res.end();
      }


      /* WEBSITE */

      if (
        req.method === "GET" &&
        req.url === "/"
      ) {

        try {

          const html =
            fs.readFileSync(
              indexPath,
              "utf8"
            );

          return send(
            res,
            200,
            html,
            "text/html; charset=utf-8"
          );

        } catch {

          return send(
            res,
            500,
            "index.html not found",
            "text/plain"
          );
        }
      }


      /* HEALTH */

      if (
        req.method === "GET" &&
        req.url === "/health"
      ) {

        return send(res, 200, {
          ok: true,
          service:
            "FlowForge AI Backend",
          geminiConfigured:
            !!API_KEY,
          imageModel:
            "gemini-3.1-flash-image"
        });
      }


      /* =====================
         EXISTING TEXT API
      ===================== */

      if (
        req.method === "POST" &&
        req.url === "/api/generate"
      ) {

        try {

          const body =
            await readBody(req);

          const prompt =
            String(
              body.prompt || ""
            ).trim();

          const duration =
            Number(
              body.duration || 10
            );

          const aspectRatio =
            String(
              body.aspectRatio ||
              "9:16"
            );

          if (!prompt) {

            return send(
              res,
              400,
              {
                error:
                  "Prompt is required"
              }
            );
          }

          const id =
            Date.now()
              .toString(36) +
            Math.random()
              .toString(36)
              .slice(2, 8);

          jobs.set(id, {
            id,
            status: "queued",
            prompt,
            duration,
            aspectRatio,
            createdAt:
              new Date().toISOString(),
            videoUrl: null,
            generatedText: null
          });

          startTextJob(
            id,
            prompt
          );

          return send(
            res,
            200,
            {
              ok: true,
              jobId: id,
              status: "queued"
            }
          );

        } catch (error) {

          return send(
            res,
            400,
            {
              error:
                error.message
            }
          );
        }
      }


      /* EXISTING TEXT STATUS */

      if (
        req.method === "GET" &&
        req.url.startsWith(
          "/api/generate/"
        )
      ) {

        const id =
          req.url
            .split("/")
            .pop();

        const job =
          jobs.get(id);

        if (!job) {

          return send(
            res,
            404,
            {
              error:
                "Job not found"
            }
          );
        }

        return send(
          res,
          200,
          job
        );
      }


      /* =====================
         IMAGE CREATE
      ===================== */

      if (
        req.method === "POST" &&
        req.url === "/api/image"
      ) {

        try {

          const body =
            await readBody(req);

          const prompt =
            String(
              body.prompt || ""
            ).trim();

          const aspectRatio =
            String(
              body.aspectRatio ||
              "9:16"
            );

          if (!prompt) {

            return send(
              res,
              400,
              {
                error:
                  "Prompt is required"
              }
            );
          }

          const id =
            Date.now()
              .toString(36) +
            Math.random()
              .toString(36)
              .slice(2, 8);

          imageJobs.set(id, {
            id,
            status: "queued",
            prompt,
            aspectRatio,
            createdAt:
              new Date().toISOString(),
            imageUrl: null
          });

          startImageJob(
            id,
            prompt,
            aspectRatio
          );

          return send(
            res,
            200,
            {
              ok: true,
              jobId: id,
              status: "queued"
            }
          );

        } catch (error) {

          return send(
            res,
            400,
            {
              error:
                error.message
            }
          );
        }
      }


      /* =====================
         IMAGE STATUS
      ===================== */

      if (
        req.method === "GET" &&
        req.url.startsWith(
          "/api/image/"
        )
      ) {

        const id =
          req.url
            .split("/")
            .pop();

        const job =
          imageJobs.get(id);

        if (!job) {

          return send(
            res,
            404,
            {
              error:
                "Image job not found"
            }
          );
        }

        return send(
          res,
          200,
          job
        );
      }


      /* 404 */

      return send(
        res,
        404,
        {
          error:
            "Cannot GET " +
            req.url
        }
      );
    }
  );


server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      "FlowForge server running on port " +
      PORT
    );

  }
);
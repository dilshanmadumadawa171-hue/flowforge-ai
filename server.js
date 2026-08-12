const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.GEMINI_API_KEY;

const jobs = new Map();
const imageJobs = new Map();

const indexPath = path.join(__dirname, "index.html");


/* =========================
   RESPONSE HELPER
========================= */

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


/* =========================
   READ REQUEST BODY
========================= */

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
   DO NOT CHANGE
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


/* =========================
   START TEXT JOB
========================= */

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
   IMAGEN 4 FAST
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


  /* Supported aspect ratios */

  let ratio = "9:16";

  if (aspectRatio === "16:9") {
    ratio = "16:9";
  }

  if (aspectRatio === "1:1") {
    ratio = "1:1";
  }

  if (aspectRatio === "3:4") {
    ratio = "3:4";
  }

  if (aspectRatio === "4:3") {
    ratio = "4:3";
  }


  console.log(
    "Generating Imagen 4 Fast image:",
    ratio
  );


  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-fast-generate-001:predict",
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": API_KEY
      },

      body: JSON.stringify({

        instances: [
          {
            prompt: prompt
          }
        ],

        parameters: {
          sampleCount: 1,
          aspectRatio: ratio
        }

      })
    }
  );


  const data = await response.json();


  console.log(
    "Imagen response status:",
    response.status
  );


  if (!response.ok) {

    console.error(
      "Imagen API error:",
      JSON.stringify(data)
    );

    throw new Error(
      data?.error?.message ||
      "Imagen image generation failed"
    );
  }


  /* =========================
     GET GENERATED IMAGE
  ========================= */

  const prediction =
    data?.predictions?.[0];


  if (!prediction) {

    console.error(
      "No prediction returned:",
      JSON.stringify(data)
    );

    throw new Error(
      "Imagen returned no prediction"
    );
  }


  const base64 =
    prediction.bytesBase64Encoded ||
    prediction.bytes_base64_encoded;


  if (!base64) {

    console.error(
      "No image bytes returned:",
      JSON.stringify(prediction)
    );

    throw new Error(
      "Imagen returned no image data"
    );
  }


  return {
    base64: base64,
    mimeType: "image/png"
  };
}


/* =========================
   START IMAGE JOB
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
      "Imagen 4 Fast is generating your image...";

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

      job.error =
        error.message;


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


      /* =====================
         CORS
      ===================== */

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


      /* =====================
         WEBSITE
      ===================== */

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

        } catch (error) {

          return send(
            res,
            500,
            "index.html not found",
            "text/plain"
          );
        }
      }


      /* =====================
         HEALTH
      ===================== */

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

          textModel:
            "gemini-3.6-flash",

          imageModel:
            "imagen-4.0-fast-generate-001"

        });
      }


      /* =====================
         TEXT CREATE
         EXISTING SYSTEM
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

            status:
              "queued",

            prompt,

            duration,

            aspectRatio,

            createdAt:
              new Date()
                .toISOString(),

            videoUrl:
              null,

            generatedText:
              null

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


      /* =====================
         TEXT STATUS
      ===================== */

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

            status:
              "queued",

            prompt,

            aspectRatio,

            createdAt:
              new Date()
                .toISOString(),

            imageUrl:
              null

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


      /* =====================
         404
      ===================== */

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


/* =========================
   START SERVER
========================= */

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
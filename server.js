const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 10000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const LUMA_API_KEY = process.env.LUMA_API_KEY;

const jobs = new Map();
const imageJobs = new Map();
const videoJobs = new Map();

const indexPath = path.join(__dirname, "index.html");


/* =========================
   RESPONSE
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
   READ BODY
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
   GEMINI TEXT
========================= */

async function generateWithGemini(prompt) {

  if (!GEMINI_API_KEY) {
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
        "x-goog-api-key": GEMINI_API_KEY.trim()
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

      console.error("Gemini text error:", error);

      job.status = "failed";
      job.error = error.message;

      jobs.set(jobId, job);
    }

  }, 300);
}


/* =========================
   LUMA AUTH
========================= */

function lumaHeaders() {

  if (!LUMA_API_KEY) {
    throw new Error(
      "LUMA_API_KEY is not configured in Render"
    );
  }

  return {
    "accept": "application/json",
    "content-type": "application/json",
    "authorization":
      "Bearer " + LUMA_API_KEY.trim()
  };
}


/* =========================
   LUMA IMAGE
========================= */

async function createLumaImage(
  prompt,
  aspectRatio
) {

  const ratio =
    ["9:16", "16:9", "1:1"].includes(aspectRatio)
      ? aspectRatio
      : "9:16";

  const response = await fetch(
    "https://api.lumalabs.ai/dream-machine/v1/generations/image",
    {
      method: "POST",

      headers: lumaHeaders(),

      body: JSON.stringify({
        prompt: prompt,
        model: "photon-1",
        aspect_ratio: ratio
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {

    throw new Error(
      data?.message ||
      data?.detail ||
      data?.error ||
      "Luma image request failed"
    );
  }

  if (!data.id) {
    throw new Error(
      "Luma did not return an image generation ID"
    );
  }

  return data;
}


/* =========================
   LUMA GENERATION STATUS
========================= */

async function getLumaGeneration(id) {

  const response = await fetch(
    "https://api.lumalabs.ai/dream-machine/v1/generations/" + id,
    {
      method: "GET",
      headers: lumaHeaders()
    }
  );

  const data = await response.json();

  if (!response.ok) {

    throw new Error(
      data?.message ||
      data?.detail ||
      data?.error ||
      "Could not check Luma generation"
    );
  }

  return data;
}


/* =========================
   IMAGE JOB
========================= */

async function startImageJob(
  jobId,
  prompt,
  aspectRatio
) {

  const job = imageJobs.get(jobId);

  if (!job) return;

  try {

    job.status = "processing";
    job.message = "Luma is generating your image...";

    imageJobs.set(jobId, job);

    const generation =
      await createLumaImage(
        prompt,
        aspectRatio
      );

    job.lumaId = generation.id;

    imageJobs.set(jobId, job);

    await pollImage(jobId);

  } catch (error) {

    console.error(
      "Luma image error:",
      error
    );

    job.status = "failed";
    job.error = error.message;

    imageJobs.set(jobId, job);
  }
}


async function pollImage(jobId) {

  const job = imageJobs.get(jobId);

  if (!job) return;

  try {

    const generation =
      await getLumaGeneration(
        job.lumaId
      );

    const state =
      generation.state ||
      generation.status;

    if (state === "completed") {

      const imageUrl =
        generation?.assets?.image ||
        generation?.asset?.image;

      if (!imageUrl) {
        throw new Error(
          "Luma completed the image but did not return an image URL"
        );
      }

      job.status = "completed";
      job.message =
        "Image generation completed ✓";
      job.imageUrl = imageUrl;

      imageJobs.set(jobId, job);

      return;
    }


    if (
      state === "failed" ||
      state === "error"
    ) {

      job.status = "failed";

      job.error =
        generation.failure_reason ||
        generation.error ||
        "Luma image generation failed";

      imageJobs.set(jobId, job);

      return;
    }


    job.status = "processing";
    job.message =
      "Luma is generating your image...";

    imageJobs.set(jobId, job);

    setTimeout(
      () => pollImage(jobId),
      2500
    );

  } catch (error) {

    console.error(
      "Image polling error:",
      error
    );

    job.status = "failed";
    job.error = error.message;

    imageJobs.set(jobId, job);
  }
}


/* =========================
   LUMA VIDEO
========================= */

async function createLumaVideo(
  prompt,
  aspectRatio,
  duration
) {

  const ratio =
    [
      "9:16",
      "16:9",
      "1:1"
    ].includes(aspectRatio)
      ? aspectRatio
      : "9:16";

  const safeDuration =
    Number(duration) === 5
      ? "5s"
      : "5s";


  const response = await fetch(
    "https://api.lumalabs.ai/dream-machine/v1/generations/video",
    {
      method: "POST",

      headers: lumaHeaders(),

      body: JSON.stringify({
        generation_type: "video",
        prompt: prompt,
        model: "ray-flash-2",
        aspect_ratio: ratio,
        duration: safeDuration,
        resolution: "720p"
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {

    throw new Error(
      data?.message ||
      data?.detail ||
      data?.error ||
      "Luma video request failed"
    );
  }

  if (!data.id) {

    throw new Error(
      "Luma did not return a video generation ID"
    );
  }

  return data;
}


/* =========================
   VIDEO JOB
========================= */

async function startVideoJob(
  jobId,
  prompt,
  aspectRatio,
  duration
) {

  const job = videoJobs.get(jobId);

  if (!job) return;

  try {

    job.status = "processing";
    job.message =
      "Luma is generating your video...";

    videoJobs.set(jobId, job);

    const generation =
      await createLumaVideo(
        prompt,
        aspectRatio,
        duration
      );

    job.lumaId = generation.id;

    videoJobs.set(jobId, job);

    await pollVideo(jobId);

  } catch (error) {

    console.error(
      "Luma video error:",
      error
    );

    job.status = "failed";
    job.error = error.message;

    videoJobs.set(jobId, job);
  }
}


async function pollVideo(jobId) {

  const job = videoJobs.get(jobId);

  if (!job) return;

  try {

    const generation =
      await getLumaGeneration(
        job.lumaId
      );

    const state =
      generation.state ||
      generation.status;


    if (state === "completed") {

      const videoUrl =
        generation?.assets?.video ||
        generation?.asset?.video;

      if (!videoUrl) {

        throw new Error(
          "Luma completed the video but did not return a video URL"
        );
      }

      job.status = "completed";

      job.message =
        "Video generation completed ✓";

      job.videoUrl = videoUrl;

      videoJobs.set(jobId, job);

      return;
    }


    if (
      state === "failed" ||
      state === "error"
    ) {

      job.status = "failed";

      job.error =
        generation.failure_reason ||
        generation.error ||
        "Luma video generation failed";

      videoJobs.set(jobId, job);

      return;
    }


    job.status = "processing";

    job.message =
      "Luma is generating your video...";

    videoJobs.set(jobId, job);

    setTimeout(
      () => pollVideo(jobId),
      3000
    );

  } catch (error) {

    console.error(
      "Video polling error:",
      error
    );

    job.status = "failed";
    job.error = error.message;

    videoJobs.set(jobId, job);
  }
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

        } catch (error) {

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
            !!GEMINI_API_KEY,

          lumaConfigured:
            !!LUMA_API_KEY,

          imageModel:
            "photon-1",

          videoModel:
            "ray-flash-2"
        });
      }


      /* =====================
         TEXT GENERATE
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
              new Date().toISOString(),

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


      /* TEXT STATUS */

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


          if (!LUMA_API_KEY) {

            return send(
              res,
              500,
              {
                error:
                  "LUMA_API_KEY is not configured in Render"
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
              new Date().toISOString(),

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


      /* IMAGE STATUS */

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
         VIDEO CREATE
      ===================== */

      if (
        req.method === "POST" &&
        req.url === "/api/video"
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
              body.duration || 5
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


          if (!LUMA_API_KEY) {

            return send(
              res,
              500,
              {
                error:
                  "LUMA_API_KEY is not configured in Render"
              }
            );
          }


          const id =
            Date.now()
              .toString(36) +
            Math.random()
              .toString(36)
              .slice(2, 8);


          videoJobs.set(id, {

            id,

            status:
              "queued",

            prompt,

            duration,

            aspectRatio,

            createdAt:
              new Date().toISOString(),

            videoUrl:
              null
          });


          startVideoJob(
            id,
            prompt,
            aspectRatio,
            duration
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


      /* VIDEO STATUS */

      if (
        req.method === "GET" &&
        req.url.startsWith(
          "/api/video/"
        )
      ) {

        const id =
          req.url
            .split("/")
            .pop();

        const job =
          videoJobs.get(id);


        if (!job) {

          return send(
            res,
            404,
            {
              error:
                "Video job not found"
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


/* =========================
   START
========================= */

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      "FlowForge server running on port " +
      PORT
    );

    console.log(
      "Gemini configured:",
      !!GEMINI_API_KEY
    );

    console.log(
      "Luma configured:",
      !!LUMA_API_KEY
    );
  }
);
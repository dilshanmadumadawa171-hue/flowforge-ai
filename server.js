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
   BODY
========================= */

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", chunk => {
      body += chunk;

      if (body.length > 10 * 1024 * 1024) {
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


/* =========================================================
   TEXT — GEMINI
========================================================= */

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
        "x-goog-api-key": GEMINI_API_KEY
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
      "Gemini request failed"
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

      const text =
        await generateWithGemini(prompt);

      job.status = "completed";
      job.generatedText = text;
      job.videoUrl = null;

      jobs.set(jobId, job);

    } catch (error) {

      console.error("TEXT ERROR:", error);

      job.status = "failed";
      job.error = error.message;

      jobs.set(jobId, job);
    }

  }, 300);
}


/* =========================================================
   LUMA HELPERS
========================================================= */

function checkLuma() {
  if (!LUMA_API_KEY) {
    throw new Error(
      "LUMA_API_KEY is not configured in Render"
    );
  }
}


function lumaHeaders() {
  return {
    "accept": "application/json",
    "authorization": `Bearer ${LUMA_API_KEY}`,
    "content-type": "application/json"
  };
}


function normalizeRatio(ratio) {

  if (ratio === "16:9") return "16:9";
  if (ratio === "1:1") return "1:1";

  return "9:16";
}


/* =========================================================
   IMAGE — LUMA PHOTON
========================================================= */

async function createLumaImage(prompt, aspectRatio) {

  checkLuma();

  const ratio =
    normalizeRatio(aspectRatio);

  const response = await fetch(
    "https://api.lumalabs.ai/dream-machine/v1/generations/image",
    {
      method: "POST",

      headers: lumaHeaders(),

      body: JSON.stringify({
        prompt: prompt,

        model: "photon-flash-1",

        aspect_ratio: ratio,

        format: "png"
      })
    }
  );

  const data = await response.json();

  console.log(
    "LUMA IMAGE:",
    JSON.stringify(data)
  );

  if (!response.ok) {

    throw new Error(
      data?.failure_reason ||
      data?.detail ||
      data?.message ||
      "Luma image generation failed"
    );
  }

  return data;
}


/* =========================================================
   IMAGE STATUS
========================================================= */

async function getLumaGeneration(id) {

  checkLuma();

  const response = await fetch(
    `https://api.lumalabs.ai/dream-machine/v1/generations/${id}`,
    {
      method: "GET",
      headers: {
        "accept": "application/json",
        "authorization": `Bearer ${LUMA_API_KEY}`
      }
    }
  );

  const data = await response.json();

  if (!response.ok) {

    throw new Error(
      data?.failure_reason ||
      data?.detail ||
      data?.message ||
      "Luma status request failed"
    );
  }

  return data;
}


/* =========================================================
   IMAGE JOB
========================================================= */

async function startImageJob(
  jobId,
  prompt,
  aspectRatio
) {

  setTimeout(async () => {

    const job =
      imageJobs.get(jobId);

    if (!job) return;

    try {

      job.status = "processing";
      job.message =
        "Generating image...";

      imageJobs.set(jobId, job);


      const generation =
        await createLumaImage(
          prompt,
          aspectRatio
        );


      job.lumaId =
        generation.id;

      imageJobs.set(jobId, job);


      await pollImageJob(jobId);


    } catch (error) {

      console.error(
        "IMAGE ERROR:",
        error
      );

      job.status = "failed";
      job.error = error.message;

      imageJobs.set(jobId, job);
    }

  }, 200);
}


async function pollImageJob(jobId) {

  const job =
    imageJobs.get(jobId);

  if (!job) return;


  try {

    const data =
      await getLumaGeneration(
        job.lumaId
      );


    if (data.state === "completed") {

      const imageUrl =
        data?.assets?.image;

      if (!imageUrl) {
        throw new Error(
          "Luma completed but returned no image URL"
        );
      }

      job.status = "completed";

      job.message =
        "Image generation completed ✓";

      job.imageUrl =
        imageUrl;

      imageJobs.set(
        jobId,
        job
      );

      return;
    }


    if (data.state === "failed") {

      job.status = "failed";

      job.error =
        data.failure_reason ||
        "Luma image generation failed";

      imageJobs.set(
        jobId,
        job
      );

      return;
    }


    job.status = "processing";

    job.message =
      "AI is creating your image...";

    imageJobs.set(
      jobId,
      job
    );


    setTimeout(
      () => pollImageJob(jobId),
      2000
    );


  } catch (error) {

    console.error(
      "IMAGE POLL ERROR:",
      error
    );

    job.status = "failed";
    job.error = error.message;

    imageJobs.set(
      jobId,
      job
    );
  }
}


/* =========================================================
   VIDEO — LUMA RAY
========================================================= */

async function createLumaVideo(
  prompt,
  aspectRatio,
  imageUrl = null
) {

  checkLuma();

  const ratio =
    normalizeRatio(aspectRatio);

  const body = {

    prompt: prompt,

    model: "ray-flash-2",

    aspect_ratio: ratio,

    duration: "5s"

  };


  /* Image → Video */

  if (imageUrl) {

    body.keyframes = {

      frame0: {
        type: "image",
        url: imageUrl
      }

    };
  }


  const response = await fetch(
    "https://api.lumalabs.ai/dream-machine/v1/generations",
    {
      method: "POST",

      headers: lumaHeaders(),

      body: JSON.stringify(body)
    }
  );


  const data =
    await response.json();


  console.log(
    "LUMA VIDEO:",
    JSON.stringify(data)
  );


  if (!response.ok) {

    throw new Error(
      data?.failure_reason ||
      data?.detail ||
      data?.message ||
      "Luma video generation failed"
    );
  }


  return data;
}


/* =========================================================
   VIDEO JOB
========================================================= */

async function startVideoJob(
  jobId,
  prompt,
  aspectRatio,
  imageUrl
) {

  setTimeout(async () => {

    const job =
      videoJobs.get(jobId);

    if (!job) return;


    try {

      job.status = "processing";

      job.message =
        "Generating video...";

      videoJobs.set(
        jobId,
        job
      );


      const generation =
        await createLumaVideo(
          prompt,
          aspectRatio,
          imageUrl
        );


      job.lumaId =
        generation.id;

      videoJobs.set(
        jobId,
        job
      );


      await pollVideoJob(jobId);


    } catch (error) {

      console.error(
        "VIDEO ERROR:",
        error
      );

      job.status = "failed";
      job.error = error.message;

      videoJobs.set(
        jobId,
        job
      );
    }

  }, 200);
}


async function pollVideoJob(jobId) {

  const job =
    videoJobs.get(jobId);

  if (!job) return;


  try {

    const data =
      await getLumaGeneration(
        job.lumaId
      );


    if (data.state === "completed") {

      const videoUrl =
        data?.assets?.video;

      if (!videoUrl) {

        throw new Error(
          "Luma completed but returned no video URL"
        );
      }


      job.status = "completed";

      job.message =
        "Video generation completed ✓";

      job.videoUrl =
        videoUrl;

      videoJobs.set(
        jobId,
        job
      );

      return;
    }


    if (data.state === "failed") {

      job.status = "failed";

      job.error =
        data.failure_reason ||
        "Luma video generation failed";

      videoJobs.set(
        jobId,
        job
      );

      return;
    }


    job.status = "processing";

    job.message =
      "AI is creating your video...";

    videoJobs.set(
      jobId,
      job
    );


    setTimeout(
      () => pollVideoJob(jobId),
      3000
    );


  } catch (error) {

    console.error(
      "VIDEO POLL ERROR:",
      error
    );

    job.status = "failed";
    job.error = error.message;

    videoJobs.set(
      jobId,
      job
    );
  }
}


/* =========================================================
   SERVER
========================================================= */

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

        return send(
          res,
          200,
          {
            ok: true,

            service:
              "FlowForge AI Backend",

            geminiConfigured:
              !!GEMINI_API_KEY,

            lumaConfigured:
              !!LUMA_API_KEY,

            text:
              "Gemini 3.6 Flash",

            image:
              "Luma Photon Flash",

            video:
              "Luma Ray Flash 2"
          }
        );
      }


      /* =================================================
         TEXT
      ================================================= */

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


          jobs.set(
            id,
            {
              id,
              status: "queued",
              prompt,
              duration,
              aspectRatio,
              createdAt:
                new Date()
                  .toISOString(),
              generatedText: null
            }
          );


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


      /* =================================================
         IMAGE CREATE
      ================================================= */

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


          imageJobs.set(
            id,
            {
              id,
              status: "queued",
              prompt,
              aspectRatio,
              createdAt:
                new Date()
                  .toISOString(),
              imageUrl: null
            }
          );


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


      /* =================================================
         VIDEO CREATE
      ================================================= */

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


          const aspectRatio =
            String(
              body.aspectRatio ||
              "9:16"
            );


          const imageUrl =
            body.imageUrl
              ? String(body.imageUrl)
              : null;


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


          videoJobs.set(
            id,
            {
              id,
              status: "queued",
              prompt,
              aspectRatio,
              imageUrl,
              createdAt:
                new Date()
                  .toISOString(),
              videoUrl: null
            }
          );


          startVideoJob(
            id,
            prompt,
            aspectRatio,
            imageUrl
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


/* =========================================================
   START
========================================================= */

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      "FlowForge AI server running on port " +
      PORT
    );

    console.log(
      "Gemini:",
      !!GEMINI_API_KEY
    );

    console.log(
      "Luma:",
      !!LUMA_API_KEY
    );
  }
);
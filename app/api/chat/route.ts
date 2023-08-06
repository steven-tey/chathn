import { kv } from "@vercel/kv";
import { Ratelimit } from "@upstash/ratelimit";
import { OpenAIStream, StreamingTextResponse } from "ai";
import { functions, runFunction } from "./functions";
import { Configuration } from "openai-edge";
import { OpenAIApi } from "openai-edge";

const config = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(config);

export const runtime = "edge";

export async function POST(req: Request) {
  // Rate limit check
  if (process.env.NODE_ENV !== "development" && process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    const ip = req.headers.get("x-forwarded-for");
    const ratelimit = new Ratelimit({
      redis: kv,
      limiter: Ratelimit.slidingWindow(50, "1 d"),
    });

    const { success, limit, reset, remaining } = await ratelimit.limit(`chathn_ratelimit_${ip}`);

    if (!success) {
      return new Response("You have reached your request limit for the day.", {
        status: 429,
        headers: {
          "X-RateLimit-Limit": limit.toString(),
          "X-RateLimit-Remaining": remaining.toString(),
          "X-RateLimit-Reset": reset.toString(),
        },
      });
    }
  }

  try {
    const { messages } = await req.json();
    const initialResponse = await openai.createChatCompletion({
      model: "gpt-4-0613",
      messages,
      functions,
      function_call: "auto",
    });
    const initialResponseJson = await initialResponse.json();
    console.log("OpenAI Response:", initialResponseJson);

    if (!initialResponseJson.choices || !initialResponseJson.choices.length) {
      throw new Error("No choices in the response from OpenAI");
    }

    const initialResponseMessage = initialResponseJson.choices[0].message;
    
    // Check for function call
    if (initialResponseMessage.function_call) {
      const { name, arguments: args } = initialResponseMessage.function_call;
      const functionResponse = await runFunction(name, JSON.parse(args));
      const finalResponse = await openai.createChatCompletion({
        model: "gpt-4-0613",
        stream: true,
        messages: [
          ...messages,
          initialResponseMessage,
          {
            role: "function",
            name: initialResponseMessage.function_call.name,
            content: JSON.stringify(functionResponse),
          },
        ],
      });
      return new StreamingTextResponse(OpenAIStream(finalResponse));
    } else {
      const chunks = initialResponseMessage.content.split(" ");
      const stream = new ReadableStream({
        async start(controller) {
          for (const chunk of chunks) {
            const bytes = new TextEncoder().encode(chunk + " ");
            controller.enqueue(bytes);
            await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 20 + 10)));
          }
          controller.close();
        },
      });
      return new StreamingTextResponse(stream);
    }
  } catch (error) {
    console.error("Error in POST:", error);
    return new Response("Internal Server Error", { status: 500 });
  }
}

import { Configuration, OpenAIApi } from "openai-edge";
import { OpenAIStream, StreamingTextResponse } from "ai";
import {
  functions,
  get_top_stories,
  get_story,
  get_story_with_comments,
  summarize_top_story,
} from "./functions";

// Create an OpenAI API client (that's edge friendly!)
const config = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(config);

export const runtime = "edge";

export async function POST(req: Request) {
  const { messages } = await req.json();

  // check if the conversation requires a function call to be made
  const initialResponse = await openai.createChatCompletion({
    model: "gpt-3.5-turbo-0613",
    messages,
    functions,
    function_call: "auto",
  });
  const initialResponseJson = await initialResponse.json();
  const initialResponseMessage = initialResponseJson?.choices?.[0]?.message;

  let finalResponse;

  if (initialResponseMessage.function_call) {
    const { name: functionName, arguments: args } =
      initialResponseMessage.function_call;
    const functionArgs = JSON.parse(args);
    let functionResponse;
    if (functionName === "get_top_stories") {
      functionResponse = await get_top_stories(functionArgs.limit);
    } else if (functionName === "get_story") {
      functionResponse = await get_story(functionArgs.id);
    } else if (functionName === "get_story_with_comments") {
      functionResponse = await get_story_with_comments(functionArgs.id);
    } else if (functionName === "summarize_top_story") {
      functionResponse = await summarize_top_story();
    }

    finalResponse = await openai.createChatCompletion({
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
    // Convert the response into a friendly text-stream
    const stream = OpenAIStream(finalResponse);
    // Respond with the stream
    return new StreamingTextResponse(stream);
  } else {
    // if there's no function call, just return the initial response
    // but first, we gotta convert initialResponse into a stream with ReadableStream
    const chunks = initialResponseMessage.content.split(" ");
    const stream = new ReadableStream({
      async start(controller) {
        for (const chunk of chunks) {
          const bytes = new TextEncoder().encode(chunk + " ");
          controller.enqueue(bytes);
          await new Promise((r) =>
            setTimeout(
              r,
              // get a random number between 10ms and 30ms to simulate a random delay
              Math.floor(Math.random() * 20 + 10),
            ),
          );
        }
        controller.close();
      },
    });
    return new StreamingTextResponse(stream);
  }
}

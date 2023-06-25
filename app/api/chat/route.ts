import { Configuration, OpenAIApi } from "openai-edge";
import { OpenAIStream, StreamingTextResponse } from "ai";

// Create an OpenAI API client (that's edge friendly!)
const config = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(config);

export const runtime = "edge";

const functions: {
  name: string;
  description: string;
  parameters: object;
}[] = [
  {
    name: "get_top_stories",
    description:
      "Get the top stories from Hacker News. Also returns the URL to each story.",
    parameters: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "The number of stories to return. Defaults to 10.",
        },
      },
      required: [],
    },
  },
  {
    name: "get_story",
    description:
      "Get a story from Hacker News. Also returns the URL to the story.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "number",
          description: "The ID of the story",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "get_story_with_comments",
    description:
      "Get a story from Hacker News with comments.  Also returns the URL to the story and each comment.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "number",
          description: "The ID of the story",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "summarize_top_story",
    description:
      "Summarize the top story from Hacker News, including both the story and its comments. Also returns the URL to the story and each comment.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
];

async function get_top_stories(limit: number = 10) {
  const response = await fetch(
    "https://hacker-news.firebaseio.com/v0/topstories.json",
  );
  const ids = await response.json();
  const stories = await Promise.all(
    ids.slice(0, limit).map((id: number) => get_story(id)),
  );
  return stories;
}

async function get_story(id: number) {
  const response = await fetch(
    `https://hacker-news.firebaseio.com/v0/item/${id}.json`,
  );
  const data = await response.json();
  return {
    ...data,
    hnUrl: `https://news.ycombinator.com/item?id=${id}`,
  };
}

async function get_story_with_comments(id: number) {
  const response = await fetch(
    `https://hacker-news.firebaseio.com/v0/item/${id}.json`,
  );
  const data = await response.json();
  const comments = await Promise.all(
    data.kids.slice(0, 10).map((id: number) => get_story(id)),
  );
  return {
    ...data,
    hnUrl: `https://news.ycombinator.com/item?id=${id}`,
    comments: comments.map((comment: any) => ({
      ...comment,
      hnUrl: `https://news.ycombinator.com/item?id=${comment.id}`,
    })),
  };
}

async function summarize_top_story() {
  const topStory = await get_top_stories(1);
  return await get_story_with_comments(topStory[0].id);
}

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
    console.log({ initialResponseMessage });
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

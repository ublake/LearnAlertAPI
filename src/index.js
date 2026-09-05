export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health check
    if (request.method === "GET" && url.pathname === "/") {
      return json({
        ok: true,
        service: "LearnAlert API",
      });
    }

    // Quiz generation endpoint
    if (request.method === "POST" && url.pathname === "/generate-quiz") {
      try {
        const body = await request.json();

        const text = body.text?.trim();

        const questionCount = Math.min(
          Math.max(Number(body.questionCount) || 10, 1),
          30
        );

        if (!text) {
          return json(
            {
              error: "Missing text",
            },
            400
          );
        }

        // Basic limit for V1
        if (text.length > 50000) {
          return json(
            {
              error: "Text is too long",
            },
            413
          );
        }

        if (!env.OPENAI_API_KEY) {
          return json(
            {
              error: "OPENAI_API_KEY is not configured",
            },
            500
          );
        }

        const openAIResponse = await fetch(
          "https://api.openai.com/v1/responses",
          {
            method: "POST",

            headers: {
              Authorization: `Bearer ${env.OPENAI_API_KEY}`,
              "Content-Type": "application/json",
            },

            body: JSON.stringify({
              model: "gpt-5.6-luna",

              reasoning: {
                effort: "low",
              },

              input: [
                {
                  role: "system",
                  content: [
                    {
                      type: "input_text",
                      text: `
You are the quiz-generation engine for LearnAlert.

Your job is to turn study material into high-quality quiz questions.

RULES:

- Use only information supported by the user's provided study material.
- Do not invent facts.
- Prioritize important concepts over trivial details.
- Avoid duplicate or extremely similar questions.
- Every question must have exactly 4 answer choices.
- Exactly one answer must be correct.
- Wrong answers should be plausible but clearly incorrect according to the material.
- Every question must include a useful hint.
- The hint should help the learner think but must not reveal the correct answer.
- Every question must include a short explanation of why the correct answer is correct.
- Generate the requested number of questions whenever the source material contains enough information.
- Keep questions concise and useful for studying.
                      `.trim(),
                    },
                  ],
                },

                {
                  role: "user",
                  content: [
                    {
                      type: "input_text",
                      text: `
Create ${questionCount} quiz questions from the following study material:

--- BEGIN STUDY MATERIAL ---

${text}

--- END STUDY MATERIAL ---
                      `.trim(),
                    },
                  ],
                },
              ],

              text: {
                format: {
                  type: "json_schema",

                  name: "learnalert_quiz",

                  strict: true,

                  schema: {
                    type: "object",

                    properties: {
                      deckTitle: {
                        type: "string",
                      },

                      questions: {
                        type: "array",

                        items: {
                          type: "object",

                          properties: {
                            question: {
                              type: "string",
                            },

                            hint: {
                              type: "string",
                            },

                            answers: {
                              type: "array",

                              items: {
                                type: "string",
                              },

                              minItems: 4,
                              maxItems: 4,
                            },

                            correctAnswerIndex: {
                              type: "integer",
                              minimum: 0,
                              maximum: 3,
                            },

                            explanation: {
                              type: "string",
                            },
                          },

                          required: [
                            "question",
                            "hint",
                            "answers",
                            "correctAnswerIndex",
                            "explanation",
                          ],

                          additionalProperties: false,
                        },
                      },
                    },

                    required: [
                      "deckTitle",
                      "questions",
                    ],

                    additionalProperties: false,
                  },
                },
              },
            }),
          }
        );

        const data = await openAIResponse.json();

        // OpenAI itself returned an error
        if (!openAIResponse.ok) {
          console.error(
            "OpenAI error:",
            JSON.stringify(data)
          );

          return json(
            {
              error: "AI generation failed",
              details: data,
            },
            openAIResponse.status
          );
        }

        // Raw fetch responses don't have the SDK's convenient
        // response.output_text property.
        // Find the output_text item inside output[].content[].
        const outputText = data.output
          ?.flatMap((item) => item.content || [])
          ?.find(
            (content) =>
              content.type === "output_text"
          )
          ?.text;

        if (!outputText) {
          console.error(
            "No output text:",
            JSON.stringify(data)
          );

          return json(
            {
              error: "AI returned no quiz",
              status: data.status,
              debug: data,
            },
            500
          );
        }

        let quiz;

        try {
          quiz = JSON.parse(outputText);
        } catch (error) {
          console.error(
            "Failed to parse AI JSON:",
            outputText
          );

          return json(
            {
              error: "Failed to parse quiz JSON",
            },
            500
          );
        }

        // Extra sanity checking before returning it to the app
        if (
          !quiz.deckTitle ||
          !Array.isArray(quiz.questions)
        ) {
          return json(
            {
              error: "AI returned an invalid quiz",
            },
            500
          );
        }

        return json({
          success: true,
          deckTitle: quiz.deckTitle,
          questions: quiz.questions,
        });
      } catch (error) {
        console.error(
          "Server error:",
          error
        );

        return json(
          {
            error: "Server error",
            message:
              error instanceof Error
                ? error.message
                : "Unknown error",
          },
          500
        );
      }
    }

    return json(
      {
        error: "Not found",
      },
      404
    );
  },
};


function json(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,

      headers: {
        "Content-Type":
          "application/json; charset=utf-8",

        // Fine for development.
        // Later we'll restrict this to your app/backend needs.
        "Access-Control-Allow-Origin": "*",
      },
    }
  );
}

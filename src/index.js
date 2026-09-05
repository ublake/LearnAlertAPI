export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Basic health check
    if (request.method === "GET" && url.pathname === "/") {
      return json({
        ok: true,
        service: "LearnAlert API",
      });
    }

    // Generate quiz
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
            { error: "Missing text" },
            400
          );
        }

        // Prevent insane requests for now
        if (text.length > 50000) {
          return json(
            { error: "Text is too long" },
            413
          );
        }

        const response = await fetch(
          "https://api.openai.com/v1/responses",
          {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
              "Content-Type": "application/json",
            },

            body: JSON.stringify({
              model: "gpt-5.6-luna",

              input: [
                {
                  role: "system",
                  content: [
                    {
                      type: "input_text",
                      text: `
You are the quiz-generation engine for LearnAlert.

Create educational questions using ONLY the supplied study material.

Rules:
- Do not introduce facts unsupported by the supplied material.
- Generate exactly the requested number of questions when possible.
- Each question must have exactly 4 answer choices.
- Exactly one answer must be correct.
- Incorrect answers should be plausible.
- Every question must include a useful hint.
- The hint must NOT reveal the answer.
- Include a short explanation for the correct answer.
- Avoid duplicate questions.
- Prioritize important concepts instead of trivial details.
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
Generate ${questionCount} quiz questions from this material:

${text}
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
                              minItems: 4,
                              maxItems: 4,
                              items: {
                                type: "string",
                              },
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
                            "explanation"
                          ],

                          additionalProperties: false,
                        },
                      },
                    },

                    required: [
                      "deckTitle",
                      "questions"
                    ],

                    additionalProperties: false,
                  },
                },
              },
            }),
          }
        );

        const data = await response.json();

        if (!response.ok) {
          console.error("OpenAI error:", data);

          return json(
            {
              error: "AI generation failed",
              details: data,
            },
            500
          );
        }

        const outputText = data.output_text;

        if (!outputText) {
          console.error("No output_text:", data);

          return json(
            { error: "AI returned no quiz" },
            500
          );
        }

        const quiz = JSON.parse(outputText);

        return json(quiz);

      } catch (error) {
        console.error(error);

        return json(
          {
            error: "Server error",
            message: error.message,
          },
          500
        );
      }
    }

    return json(
      { error: "Not found" },
      404
    );
  },
};


function json(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type": "application/json",
      },
    }
  );
}

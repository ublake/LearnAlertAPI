import { generateDeck } from "./generateDeck.js";

export async function legacyQuiz(request, env, requestId, call = null) {
  const originalBody = await request.json();

  const questionCount = Math.min(
    Math.max(Number(originalBody?.questionCount) || 10, 1),
    50
  );

  const translatedBody = {
    text: originalBody?.text,
    maxCards: questionCount,
    mode: "exam",
    difficulty: "auto",
    preferredCardTypes: ["multiple_choice"],
    userInstruction:
      "Create multiple-choice cards only. Generate the requested number when the source supports that many useful distinct questions."
  };

  const translatedRequest = new Request(request.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(translatedBody)
  });

  const response = await generateDeck(
    translatedRequest,
    env,
    requestId,
    call
  );

  const data = await response.json();

  if (!data.success) {
    return new Response(JSON.stringify(data), {
      status: response.status,
      headers: response.headers
    });
  }

  if (data.action === "chat" || !data.deck) {
    return new Response(
      JSON.stringify(
        {
          success: true,
          action: "chat",
          assistantMessage: data.assistantMessage,
          deck: null,
          questions: []
        },
        null,
        2
      ),
      {
        status: 200,
        headers: response.headers
      }
    );
  }

  const questions = data.deck.cards
    .filter((card) => card.type === "multiple_choice")
    .map((card) => ({
      question: card.prompt,
      hint: card.hint,
      answers: card.options,
      correctAnswerIndex: card.correctAnswerIndex,
      // The deck schema no longer carries per-card explanations; the key stays
      // so the legacy response shape does not change.
      explanation: ""
    }));

  return new Response(
    JSON.stringify(
      {
        success: true,
        action: "deck",
        deckTitle: data.deck.title,
        questions
      },
      null,
      2
    ),
    {
      status: 200,
      headers: response.headers
    }
  );
}

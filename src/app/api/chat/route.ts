import { NextResponse } from "next/server";

export async function POST(req: Request) {
  const { message, project } = await req.json();
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({
      reply: "The AI companion interface is ready, but Gemini is not connected yet. Add GEMINI_API_KEY to .env.local and restart the development server. Meanwhile, you can use the script, shot planner and reference library locally."
    });
  }

  const system = `You are the creative companion inside Wonderboy AI Studio. Help develop films, scripts, characters, locations and cinematic shots. Be practical and collaborative. Preserve established continuity. Do not invent changes to a character or location's canonical details unless the user requests it. Project: ${JSON.stringify(project)}`;
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ system_instruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: message }] }] })
    });
    const data = await response.json();
    if (!response.ok) return NextResponse.json({ error: data.error?.message || "Gemini request failed." }, { status: response.status });
    const reply = data.candidates?.[0]?.content?.parts?.map((p: {text?:string})=>p.text || "").join("") || "I couldn't produce a response.";
    return NextResponse.json({ reply });
  } catch {
    return NextResponse.json({ error: "Could not reach Gemini. Check your connection and API key." }, { status: 502 });
  }
}

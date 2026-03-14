/**
 * STEVVE – SaaS Backend (Complete Production Version)
 * Slack + Paddle + Trial + Digest + Expansion + Theme Intelligence
 */

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const dotenv = require('dotenv');
const { Paddle } = require('@paddle/paddle-node-sdk');

dotenv.config();

/* ============================
   CONFIGURATION
============================ */

const {
    SLACK_BOT_TOKEN,
    SLACK_SIGNING_SECRET,
    GROQ_API_KEY,
    PADDLE_API_KEY,
    PADDLE_WEBHOOK_SECRET,
    PADDLE_PRICE_ID,
    APP_URL,
    PORT = 3000,
    PADDLE_ENV = 'sandbox',
} = process.env;

if (!SLACK_BOT_TOKEN || !SLACK_SIGNING_SECRET || !GROQ_API_KEY ||
    !PADDLE_API_KEY || !PADDLE_WEBHOOK_SECRET ||
    !PADDLE_PRICE_ID || !APP_URL) {
    console.error("❌ Missing required env variables.");
    process.exit(1);
}

const TRIAL_DURATION_MS = parseInt(process.env.TRIAL_DURATION_MS || (3 * 24 * 60 * 60 * 1000));
const DIGEST_INTERVAL_MS = parseInt(process.env.DIGEST_INTERVAL_MS || (24 * 60 * 60 * 1000));

/* ============================
   DATABASE
============================ */

const db = new sqlite3.Database('./stevvve.db');

const dbRun = (sql, params = []) =>
    new Promise((resolve, reject) =>
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve(this);
        })
    );

const dbGet = (sql, params = []) =>
    new Promise((resolve, reject) =>
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        })
    );

const dbAll = (sql, params = []) =>
    new Promise((resolve, reject) =>
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        })
    );

db.serialize(async () => {

    await dbRun(`
        CREATE TABLE IF NOT EXISTS workspaces (
            workspaceId TEXT PRIMARY KEY,
            installedAt INTEGER,
            trialEndsAt INTEGER,
            planStatus TEXT DEFAULT 'trial',
            paddleSubscriptionId TEXT,
            upgradePromptSentAt INTEGER DEFAULT 0
        )
    `);

    await dbRun(`
        CREATE TABLE IF NOT EXISTS users (
            slackUserId TEXT PRIMARY KEY,
            workspaceId TEXT,
            styleProfile TEXT,
            onboardingStep TEXT DEFAULT 'INIT',
            pendingMomentId INTEGER,
            thinkingProfile TEXT,
topics TEXT,
voiceExamples TEXT,
            pendingAngles TEXT,
            lastDigestAt INTEGER DEFAULT 0,
            welcomed INTEGER DEFAULT 0
        )
    `);

    await dbRun(`
CREATE TABLE IF NOT EXISTS moments (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 slackUserId TEXT,
 rawText TEXT,
 context TEXT,
 reason TEXT,
 theme TEXT,
 createdAt INTEGER,
 surfaced INTEGER DEFAULT 0,
 sent INTEGER DEFAULT 0
)
`);

    console.log("✅ Database initialized.");
});

/* ============================
   SERVICES
============================ */

const paddle = new Paddle(PADDLE_API_KEY, {
    environment: PADDLE_ENV === 'sandbox' ? 'sandbox' : 'production'
});

const slackClient = axios.create({
    baseURL: 'https://slack.com/api',
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` }
});

const groq = axios.create({
    baseURL: 'https://api.groq.com/openai/v1',
    headers: { Authorization: `Bearer ${GROQ_API_KEY}` }
});

/* ============================
   BILLING LOGIC
============================ */

const createWorkspaceIfNotExists = async (workspaceId) => {
    await dbRun(`
        INSERT OR IGNORE INTO workspaces
        (workspaceId, installedAt, trialEndsAt, planStatus, upgradePromptSentAt)
        VALUES (?, ?, ?, 'trial', 0)
    `, [workspaceId, Date.now(), Date.now() + TRIAL_DURATION_MS]);
};

const createUserIfNotExists = async (userId, workspaceId) => {
    await dbRun(`
        INSERT OR IGNORE INTO users
        (slackUserId, workspaceId, lastDigestAt, welcomed, onboardingStep)
        VALUES (?, ?, 0, 0, 'INIT')
    `, [userId, workspaceId]);
};

const getWorkspace = async (workspaceId) => {
    return await dbGet(`SELECT * FROM workspaces WHERE workspaceId = ?`, [workspaceId]);
};

const hasValidAccess = (workspace) => {
    if (!workspace) return false;
    if (workspace.planStatus === 'active') return true;
    if (workspace.planStatus === 'trial' && Date.now() < workspace.trialEndsAt) return true;
    return false;
};

const generateCheckout = async (workspaceId) => {
    const transaction = await paddle.transactions.create({
        items: [{ price_id: PADDLE_PRICE_ID, quantity: 1 }],
        custom_data: { workspace_id: workspaceId }
    });

    return transaction.checkout.url;
};

/* ============================
   AI LOGIC
============================ */

const safeJSONParse = (text, fallback) => {
    try { return JSON.parse(text); }
    catch { return fallback; }
};

/* ============================
   SIGNAL DETECTION + THEME
============================ */

const judgeContent = async (text, context = "") => {

    try {

        const res = await groq.post('/chat/completions', {
            model: "llama-3.3-70b-versatile",
            temperature: 0.1,
            messages: [
                {
                    role: "system",
                    content: `
You detect founder insights that could become LinkedIn posts.

Evaluate the user's statement.

Score the following from 0–10:

1. Originality
2. Contrarian insight
3. Generalizable principle
4. Clarity
5. Intellectual leverage

Then compute a score out of 100.

Rules:
Only mark worthy if score >= 70.

Return STRICT JSON:

{
 "worthy": true|false,
 "score": number,
 "reason": "short explanation",
 "theme": "product | distribution | hiring | ai | startups | psychology | learning"
}
`
                },
                {
                    role: "user",
                    content: `
Conversation context:
${context}

User message:
${text}
`
                }
            ],
            response_format: { type: "json_object" }
        });

        return safeJSONParse(res.data.choices[0].message.content, { worthy: false });

    } catch {
        return { worthy: false };
    }
};

/* ============================
   STYLE ANALYSIS
============================ */

const analyzeStyle = async (text) => {

    const res = await groq.post('/chat/completions', {

        model: "llama-3.3-70b-versatile",
        temperature: 0.2,

        messages: [
            {
                role: "system",
                content: `

Analyze the LinkedIn post.

Extract the author's thinking patterns.

Return STRICT JSON:

{
 "audience":"",
 "tone":"",
 "sentenceLength":"",
 "hookStyle":"",
 "formatting":"",
 "rhythm":"",
 "conviction":"",
 "thinkingStyle":"",
 "topicDomain":"",
 "signatureMoves":[
   "pattern used in their writing"
 ],
 "keyIdeas":[
   "ideas they frequently discuss"
 ]
}

`
            },
            { role: "user", content: text }
        ],

        response_format: { type: "json_object" }

    });

    return res.data.choices[0].message.content;

};

/* ============================
   DONNA CORE ENGINE
============================ */

const generateAngles = async (rawText, styleProfile) => {
    const res = await groq.post('/chat/completions', {
        model: "llama-3.3-70b-versatile",
        messages: [
            {
                role: "system",
                content: `
You elevate founders.

Never summarize.
Never hedge.
Never sound like a consultant.

Identify:
- What most people believe
- What the founder sees differently
- The tension
- The leverage
Angles should sound like potential LinkedIn hooks.

Avoid corporate language.

Bad example:
"The need for a new mindset in hiring"

Good example:
"AI didn't remove jobs. It removed the cost of trying things."

Follow this style STRICTLY:
${styleProfile}

Return STRICT JSON:
{
  "beliefMostHave": "",
  "founderSees": "",
  "coreTension": "",
  "sharpened_line": "",
  "angles": ["", "", ""]
}
`
            },
            { role: "user", content: rawText }
        ],
        response_format: { type: "json_object" },
        temperature: 0.55
    });

    return safeJSONParse(res.data.choices[0].message.content, {});
};

/* ============================
   EXPANSION
============================ */

const expandPost = async (moment, angle, styleProfile) => {

    const res = await groq.post('/chat/completions', {

        model: "llama-3.3-70b-versatile",
        temperature: 0.6,

        messages: [
            {
                role: "system",

                content: `
You are writing a LinkedIn post for a thoughtful builder.

Your job is to expand the user's idea while positioning them as a thinker in their space.

STYLE PROFILE:
${styleProfile}

CRITICAL RULES

Never invent stories.
Never fabricate experiences.
Never cite studies or reports.

Only work with the idea provided.

---

STEP 0 — COMPRESS THE IDEA

Rewrite the core idea into ONE sharp sentence.

Example:

"AI isn't replacing jobs.
It's replacing the cost of trying things."

This line must remain the central idea of the post.

Do not drift away from it.

---

STEP 1 — CREATE A CONTRARIAN HOOK

The first 2 lines must challenge a common belief.

Example:

Everyone thinks AI will replace jobs.

That's not the real shift.

---

STEP 2 — EXPAND THE INSIGHT

Explain the idea using short sentences.

Prefer sentences under 12 words.

Most paragraphs should be one sentence.

Avoid long explanations.

---

STEP 3 — BUILD THE IMPLICATION

Show why this idea changes how builders think.

Position the author as someone who sees a deeper pattern.

---

STEP 4 — END WITH A SHARP TAKEAWAY

The last lines should feel memorable.

---

FORMAT

Hook

↓

Insight

↓

Implication

↓

Takeaway

---

STYLE RULES

Short paragraphs.

One sentence per paragraph.

200–350 words.

Avoid corporate or motivational language.

BANNED CONTENT

Do NOT write about:

- being bold
- visionary leaders
- staying ahead of the curve
- innovation buzzwords
- courage
- motivational advice

Write like a thoughtful builder thinking out loud on LinkedIn.
`
            },
            {
                role: "user",
                content: `

Original Slack idea:
${moment.rawText}

Conversation context:
${moment.context}

Direction:
${angle}

Write a LinkedIn post based ONLY on the idea above.
`
            }
        ]

    });

    return res.data.choices[0].message.content;

};

/* ============================
   SLACK HELPER
============================ */
const getConversationContext = async (channel, ts) => {

    try {

        const res = await slackClient.get('/conversations.history', {
            params: {
                channel,
                limit: 6
            }
        });

        const msgs = res.data.messages
            .filter(m => !m.bot_id)
            .slice(1)
            .reverse()
            .map(m => m.text)
            .join("\n");

        return msgs;

    } catch {
        return "";
    }
};

const sendDM = async (userId, text) => {
    try {
        await slackClient.post('/chat.postMessage', {
            channel: userId,
            text
        });
    } catch (e) {
        console.error("Slack DM error:", e.message);
    }
};

/* ============================
   DIGEST WORKER (UPGRADED FORMAT)
============================ */

const runDigestWorker = async () => {

    const now = Date.now();
    const dueTimestamp = now - DIGEST_INTERVAL_MS;

    const dueUsers = await dbAll(`
        SELECT u.*, w.planStatus, w.trialEndsAt
        FROM users u
        JOIN workspaces w ON u.workspaceId = w.workspaceId
        WHERE u.lastDigestAt < ?
        AND u.onboardingStep = 'ACTIVE'
    `, [dueTimestamp]);

    for (const user of dueUsers) {

        const valid = (user.planStatus === 'active') ||
            (user.planStatus === 'trial' && now < user.trialEndsAt);

        if (!valid) continue;

        const moment = await dbGet(`
            SELECT * FROM moments
            WHERE slackUserId = ?
            AND surfaced = 0
            ORDER BY createdAt ASC
            LIMIT 1
        `, [user.slackUserId]);

        if (!moment) continue;

        const result = await generateAngles(moment.rawText, user.styleProfile);

        if (!result.angles || result.angles.length === 0) continue;

        const dm = await generateDonnaDM(
            moment,
            result
        );

        await sendDM(user.slackUserId, dm);

        await dbRun(`UPDATE moments SET surfaced = 1 WHERE id = ?`, [moment.id]);

        await dbRun(`
            UPDATE users
            SET pendingMomentId = ?, pendingAngles = ?, lastDigestAt = ?
            WHERE slackUserId = ?
        `, [moment.id, JSON.stringify(result.angles), now, user.slackUserId]);
    }
};

const generateDonnaDM = async (moment, analysis) => {

    const res = await groq.post('/chat/completions', {

        model: "llama-3.3-70b-versatile",
        temperature: 0.75,

        messages: [
            {
                role: "system",
                content: `
You are Stevve.

Stevve behaves like Donna Paulsen from Suits.

Donna is not a coach.
Donna is not a consultant.
Donna is a sharp observer.

She reads conversations and casually points out when someone says something interesting.

The tone should feel like a smart colleague sending a DM.

Not an essay.
Not a lecture.
Not advice.

The DM should feel like:

• "that line you dropped earlier..."
• "something interesting in what you said..."
• "there's a sharper idea hiding there..."

The goal is to:

1. Quote or reference the user's line
2. Reveal the deeper version of the idea
3. Sharpen it
4. Ask if they want to turn it into a LinkedIn post

Rules:

- Conversational
- Natural
- Short paragraphs
- Maximum 300 words
- Never sound like a blog post
- Never explain academically
- Never use corporate phrases

Bad phrases (NEVER use):

"game changer"
"future of work"
"this highlights"
"this suggests"
"the landscape of innovation"

The message should feel like a human thought.

Example tone:

That line you dropped earlier caught my attention.

> "AI will replace the cost of experimentation."

Most people are still thinking about jobs.

But the real shift is that **trying things just became cheap.**

Which means execution stops being the bottleneck.

Judgment becomes the bottleneck.

That’s a pretty clean LinkedIn thought.

Want me to expand it?

Reply "expand" if you want me to turn it into a post.


`
            },
            {
                role: "user",
                content: `

Conversation context:
${moment.context}

User line:
"${moment.rawText}"

Internal interpretation:

beliefMostHave: ${analysis.beliefMostHave}
founderSees: ${analysis.founderSees}
coreTension: ${analysis.coreTension}
sharpened_line: ${analysis.sharpened_line}

Write the DM.

`
            }
        ]

    });

    return res.data.choices[0].message.content;

};
/* ============================
   EXPRESS SERVER
============================ */

const app = express();

/* Paddle webhook */

app.use('/paddle-webhook', express.raw({ type: 'application/json' }));

app.post('/paddle-webhook', async (req, res) => {

    const signature = req.headers['paddle-signature'];

    try {
        const event = paddle.webhooks.unmarshal(
            req.body,
            PADDLE_WEBHOOK_SECRET,
            signature
        );

        if (event.event_type === 'subscription.created') {
            await dbRun(`
                UPDATE workspaces
                SET planStatus = 'active',
                    paddleSubscriptionId = ?
                WHERE workspaceId = ?
            `, [event.data.id, event.data.custom_data.workspace_id]);
        }

        if (event.event_type === 'subscription.canceled') {
            await dbRun(`
                UPDATE workspaces
                SET planStatus = 'canceled'
                WHERE paddleSubscriptionId = ?
            `, [event.data.id]);
        }

        res.status(200).send('OK');

    } catch (e) {
        console.error("Paddle webhook error:", e.message);
        res.status(400).send();
    }
});

/* Slack events */

app.post('/slack/events', express.raw({ type: '*/*' }), async (req, res) => {

    const bodyString = req.body.toString();
    let body;

    try { body = JSON.parse(bodyString); }
    catch { return res.status(400).send(); }

    if (body.type === 'url_verification') {
        return res.status(200).json({ challenge: body.challenge });
    }

    const timestamp = req.headers['x-slack-request-timestamp'];
    const signature = req.headers['x-slack-signature'];

    const hmac = crypto.createHmac('sha256', SLACK_SIGNING_SECRET);
    const mySig = `v0=${hmac.update(`v0:${timestamp}:${bodyString}`).digest('hex')}`;

    if (!signature ||
        signature.length !== mySig.length ||
        !crypto.timingSafeEqual(Buffer.from(mySig), Buffer.from(signature))) {
        return res.status(403).send();
    }

    res.status(200).send();

    const event = body.event;
    if (!event || event.bot_id) return;

    const workspaceId = body.team_id;
    const userId = event.user;

    await createWorkspaceIfNotExists(workspaceId);
    await createUserIfNotExists(userId, workspaceId);

    const workspace = await getWorkspace(workspaceId);
    if (!hasValidAccess(workspace)) return;

    if (event.type === 'message') {

        if (event.channel_type === 'im' || event.channel?.startsWith('D')) {

            const user = await dbGet(`SELECT * FROM users WHERE slackUserId = ?`, [userId]);
            if (!user) return;

            if (user.onboardingStep === 'INIT') {
                await sendDM(userId, `Send me 2 LinkedIn posts you've written.

The kind that represent how you think in public.

I'll use them to understand:
• how you structure ideas
• what you care about
• how strongly you state opinions`);
                await dbRun(`UPDATE users SET onboardingStep = 'WAITING_FOR_SAMPLE' WHERE slackUserId = ?`, [userId]);
                return;
            }

            if (user.onboardingStep === 'WAITING_FOR_SAMPLE') {

                if (!event.text || event.text.length < 100) {
                    return sendDM(userId, "Send a full LinkedIn post.");
                }

                const profile = await analyzeStyle(event.text);

                await dbRun(`
                    UPDATE users
                    SET styleProfile = ?, onboardingStep = 'ACTIVE'
                    WHERE slackUserId = ?
                `, [profile, userId]);

                return sendDM(userId, "Got it. I understand how you think. I’ll surface the sharp ones.");
            }

            const expandMatch = event.text?.match(/expand\s*(\d+)?/i);

            if (expandMatch && user.pendingMomentId && user.pendingAngles) {

                let index = expandMatch[1]
                    ? parseInt(expandMatch[1]) - 1
                    : 0; // default to first angle

                const angles = safeJSONParse(user.pendingAngles, []);

                if (index >= 0 && index < angles.length) {

                    const moment = await dbGet(
                        `SELECT * FROM moments WHERE id = ?`,
                        [user.pendingMomentId]
                    );

                    if (!moment) return;

                    const draft = await expandPost(
                        moment,
                        angles[index],
                        user.styleProfile
                    );

                    await sendDM(userId, draft);

                    await dbRun(`UPDATE moments SET sent = 1 WHERE id = ?`, [moment.id]);
                }
            }

        } else {

            if (event.text && event.text.length > 50) {

                const context = await getConversationContext(event.channel);

                const judgment = await judgeContent(
                    event.text,
                    context
                );

                if (judgment.worthy) {

                    await dbRun(`
    INSERT INTO moments
    (slackUserId, rawText, context, reason, theme, createdAt)
    VALUES (?, ?, ?, ?, ?, ?)
    `, [
                        userId,
                        event.text,
                        context,
                        judgment.reason,
                        judgment.theme,
                        Date.now()
                    ]);

                }
            }
        }
    }
});

/* ============================
   START SERVER
============================ */

app.listen(PORT, () => {
    console.log(`🚀 Stevve running on ${PORT}`);
    setInterval(runDigestWorker, 60 * 1000);
});
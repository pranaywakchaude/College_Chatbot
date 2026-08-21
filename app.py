"""
Flask AI Chatbot Backend
========================
A RESTful Flask application that integrates with OpenAI's GPT models
to provide intelligent chatbot responses, with SQLite persistence.
"""

import os
import uuid
import logging
from datetime import datetime
from flask import Flask, request, jsonify, render_template, session
from flask_sqlalchemy import SQLAlchemy
from flask_cors import CORS
from openai import OpenAI
from dotenv import load_dotenv

# ── Load environment variables from .env ──────────────────────────────────────
load_dotenv()

# ── App configuration ─────────────────────────────────────────────────────────
app = Flask(__name__)
app.secret_key = os.getenv("FLASK_SECRET_KEY", os.urandom(32))

CORS(app)  # Allow cross-origin requests during development

# Database: defaults to SQLite; swap DATABASE_URL for PostgreSQL in production
app.config["SQLALCHEMY_DATABASE_URI"] = os.getenv(
    "DATABASE_URL", "sqlite:///chatbot.db"
)
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False

db = SQLAlchemy(app)

# OpenAI client (key read from OPENAI_API_KEY env var)
openai_client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

# Model to use; override via OPENAI_MODEL env var
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-3.5-turbo")

# System prompt that shapes the chatbot's personality
SYSTEM_PROMPT = (
    "You are College ChatBot, a knowledgeable and friendly academic assistant for college students. "
    "For every question or topic, always structure your answer clearly using the following format where applicable:\n\n"
    "**Definition:** Provide a clear, concise definition of the topic.\n\n"
    "**Key Points:**\n"
    "1. First important point\n"
    "2. Second important point\n"
    "3. (Continue as needed)\n\n"
    "**Characteristics:** List the main characteristics or features.\n\n"
    "**Types / Categories:** If applicable, list and briefly explain different types or categories.\n\n"
    "**Examples:** Give 1-2 real-world or academic examples.\n\n"
    "**Summary:** End with a brief one-line summary.\n\n"
    "Always respond in a point-wise, well-organized manner. "
    "Use numbered lists for steps or sequential information, and bullet points for features or characteristics. "
    "If a section is not applicable for the question, skip it gracefully. "
    "If you are unsure about something, say so honestly."
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


# ── Database Models ───────────────────────────────────────────────────────────

class User(db.Model):
    """Represents a chat session user (anonymous or named)."""
    __tablename__ = "users"

    id          = db.Column(db.Integer, primary_key=True)
    session_id  = db.Column(db.String(64), unique=True, nullable=False, index=True)
    username    = db.Column(db.String(80), nullable=True)
    created_at  = db.Column(db.DateTime, default=datetime.utcnow)
    last_seen   = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    conversations = db.relationship("Conversation", backref="user", lazy=True, cascade="all, delete-orphan")

    def to_dict(self):
        return {
            "id":         self.id,
            "session_id": self.session_id,
            "username":   self.username,
            "created_at": self.created_at.isoformat(),
        }


class Conversation(db.Model):
    """Groups messages that belong to one chat session."""
    __tablename__ = "conversations"

    id         = db.Column(db.Integer, primary_key=True)
    user_id    = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    title      = db.Column(db.String(200), nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    messages = db.relationship("Message", backref="conversation", lazy=True,
                               cascade="all, delete-orphan",
                               order_by="Message.created_at")

    def to_dict(self, include_messages=False):
        data = {
            "id":         self.id,
            "title":      self.title,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
        }
        if include_messages:
            data["messages"] = [m.to_dict() for m in self.messages]
        return data


class Message(db.Model):
    """A single turn (user or assistant) within a conversation."""
    __tablename__ = "messages"

    id              = db.Column(db.Integer, primary_key=True)
    conversation_id = db.Column(db.Integer, db.ForeignKey("conversations.id"), nullable=False)
    role            = db.Column(db.String(20), nullable=False)   # "user" | "assistant"
    content         = db.Column(db.Text, nullable=False)
    tokens_used     = db.Column(db.Integer, nullable=True)
    created_at      = db.Column(db.DateTime, default=datetime.utcnow)

    def to_dict(self):
        return {
            "id":         self.id,
            "role":       self.role,
            "content":    self.content,
            "created_at": self.created_at.isoformat(),
        }


# ── Helpers ───────────────────────────────────────────────────────────────────

def get_or_create_user() -> User:
    """Return the User for the current Flask session, creating one if needed."""
    if "session_id" not in session:
        session["session_id"] = str(uuid.uuid4())

    sid = session["session_id"]
    user = User.query.filter_by(session_id=sid).first()

    if not user:
        user = User(session_id=sid)
        db.session.add(user)
        db.session.commit()
        logger.info("Created new user: %s", sid)

    return user


def build_openai_messages(conversation: Conversation) -> list[dict]:
    """Convert stored messages to the format expected by the OpenAI Chat API."""
    history = [{"role": "system", "content": SYSTEM_PROMPT}]
    for msg in conversation.messages[-20:]:   # cap at last 20 turns for token safety
        history.append({"role": msg.role, "content": msg.content})
    return history


def call_openai(messages: list[dict]) -> tuple[str, int]:
    """
    Send a list of messages to OpenAI and return (reply_text, tokens_used).
    Raises RuntimeError on API failure.
    """
    response = openai_client.chat.completions.create(
        model=OPENAI_MODEL,
        messages=messages,
        max_tokens=1024,
        temperature=0.7,
    )
    reply      = response.choices[0].message.content.strip()
    tokens     = response.usage.total_tokens
    return reply, tokens


# ── Routes ────────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    """Serve the chatbot frontend."""
    return render_template("index.html")


@app.route("/api/user", methods=["GET"])
def get_user():
    """Return current session user info."""
    user = get_or_create_user()
    return jsonify({"status": "ok", "user": user.to_dict()})


@app.route("/api/user/name", methods=["POST"])
def set_username():
    """Allow the user to set a display name."""
    data = request.get_json(silent=True) or {}
    name = (data.get("username") or "").strip()[:80]

    if not name:
        return jsonify({"status": "error", "message": "username is required"}), 400

    user = get_or_create_user()
    user.username = name
    db.session.commit()
    return jsonify({"status": "ok", "user": user.to_dict()})


@app.route("/api/conversations", methods=["GET"])
def list_conversations():
    """List all conversations for the current user."""
    user = get_or_create_user()
    convos = (
        Conversation.query
        .filter_by(user_id=user.id)
        .order_by(Conversation.updated_at.desc())
        .limit(50)
        .all()
    )
    return jsonify({"status": "ok", "conversations": [c.to_dict() for c in convos]})


@app.route("/api/conversations", methods=["POST"])
def create_conversation():
    """Start a new conversation."""
    user = get_or_create_user()
    convo = Conversation(user_id=user.id, title="New Chat")
    db.session.add(convo)
    db.session.commit()
    return jsonify({"status": "ok", "conversation": convo.to_dict()}), 201


@app.route("/api/conversations/<int:convo_id>", methods=["GET"])
def get_conversation(convo_id):
    """Fetch a conversation with all its messages."""
    user  = get_or_create_user()
    convo = Conversation.query.filter_by(id=convo_id, user_id=user.id).first()

    if not convo:
        return jsonify({"status": "error", "message": "Conversation not found"}), 404

    return jsonify({"status": "ok", "conversation": convo.to_dict(include_messages=True)})


@app.route("/api/chat", methods=["POST"])
def chat():
    """
    Core endpoint: receive a user message, query OpenAI, persist both turns,
    and return the assistant's reply.

    Request body (JSON):
        {
            "message":         "Hello!",          # required
            "conversation_id": 42                 # optional; creates new if absent
        }
    """
    data    = request.get_json(silent=True) or {}
    message = (data.get("message") or "").strip()

    if not message:
        return jsonify({"status": "error", "message": "message is required"}), 400

    if len(message) > 4000:
        return jsonify({"status": "error", "message": "message too long (max 4000 chars)"}), 400

    user = get_or_create_user()

    # ── Resolve or create conversation ────────────────────────────────────────
    convo_id = data.get("conversation_id")
    if convo_id:
        convo = Conversation.query.filter_by(id=convo_id, user_id=user.id).first()
        if not convo:
            return jsonify({"status": "error", "message": "Conversation not found"}), 404
    else:
        convo = Conversation(user_id=user.id, title=message[:60])
        db.session.add(convo)
        db.session.flush()   # get convo.id without committing yet

    # ── Persist user message ───────────────────────────────────────────────────
    user_msg = Message(conversation_id=convo.id, role="user", content=message)
    db.session.add(user_msg)
    db.session.flush()

    # ── Call OpenAI ────────────────────────────────────────────────────────────
    openai_messages = build_openai_messages(convo)
    try:
        reply, tokens = call_openai(openai_messages)
    except Exception as exc:
        db.session.rollback()
        logger.error("OpenAI API error: %s", exc)
        return jsonify({"status": "error", "message": "AI service unavailable. Please try again."}), 503

    # ── Persist assistant reply ────────────────────────────────────────────────
    assistant_msg = Message(
        conversation_id=convo.id,
        role="assistant",
        content=reply,
        tokens_used=tokens,
    )
    db.session.add(assistant_msg)

    # Update conversation title from first user message if still default
    if convo.title == "New Chat":
        convo.title = message[:60]

    convo.updated_at = datetime.utcnow()
    db.session.commit()

    logger.info("Chat [convo=%d, tokens=%d]", convo.id, tokens)

    return jsonify({
        "status":          "ok",
        "reply":           reply,
        "conversation_id": convo.id,
        "tokens_used":     tokens,
        "message_id":      assistant_msg.id,
    })


@app.route("/api/conversations/<int:convo_id>", methods=["DELETE"])
def delete_conversation(convo_id):
    """Delete a conversation and all its messages."""
    user  = get_or_create_user()
    convo = Conversation.query.filter_by(id=convo_id, user_id=user.id).first()

    if not convo:
        return jsonify({"status": "error", "message": "Conversation not found"}), 404

    db.session.delete(convo)
    db.session.commit()
    return jsonify({"status": "ok", "message": "Conversation deleted"})


@app.route("/api/health", methods=["GET"])
def health():
    """Simple liveness probe."""
    return jsonify({"status": "ok", "model": OPENAI_MODEL, "time": datetime.utcnow().isoformat()})


# ── Initialise DB and run ─────────────────────────────────────────────────────

with app.app_context():
    db.create_all()
    logger.info("Database tables ready.")

if __name__ == "__main__":
    debug = os.getenv("FLASK_DEBUG", "false").lower() == "true"
    app.run(host="0.0.0.0", port=5000, debug=debug)

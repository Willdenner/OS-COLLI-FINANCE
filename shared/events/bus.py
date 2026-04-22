"""
Event Bus — Colli Finance OS
Comunicação entre Agente FP&A e os Bots via Redis Pub/Sub
"""

import json
import asyncio
import logging
from enum import Enum
from dataclasses import dataclass, field, asdict
from datetime import datetime
from typing import Callable, Optional
import redis.asyncio as aioredis
import os

logger = logging.getLogger(__name__)


class EventType(str, Enum):
    # ── Agente → Bots ────────────────────────
    TRIGGER_EXTRACTION   = "trigger_extraction"
    TRIGGER_COBRANCA     = "trigger_cobranca"
    SYNC_CONTA_AZUL      = "sync_conta_azul"
    GENERATE_REPORT      = "generate_report"
    SEND_ALERT           = "send_alert"
    APPROVE_PAYMENT      = "approve_payment"     # Aguarda aprovação humana

    # ── Bots → Agente ─────────────────────────
    EXTRACTION_DONE      = "extraction_done"
    PAYMENT_CONFIRMED    = "payment_confirmed"
    COBRANCA_SENT        = "cobranca_sent"
    COBRANCA_RESPONDED   = "cobranca_responded"
    CONTA_AZUL_SYNCED    = "conta_azul_synced"
    ERROR_OCCURRED       = "error_occurred"


@dataclass
class Event:
    type: EventType
    payload: dict
    source: str                           # Qual serviço emitiu
    timestamp: str = field(
        default_factory=lambda: datetime.now().isoformat()
    )
    correlation_id: Optional[str] = None  # Para rastrear fluxos completos

    def to_json(self) -> str:
        d = asdict(self)
        d["type"] = self.type.value
        return json.dumps(d)

    @classmethod
    def from_json(cls, data: str) -> "Event":
        d = json.loads(data)
        d["type"] = EventType(d["type"])
        return cls(**d)


class EventBus:
    """
    Bus de eventos baseado em Redis Pub/Sub.
    Cada serviço escuta seu próprio canal + canal broadcast.
    """

    BROADCAST_CHANNEL = "colli:broadcast"

    def __init__(self):
        self._redis: Optional[aioredis.Redis] = None
        self._handlers: dict[EventType, list[Callable]] = {}
        self._service_name = os.getenv("SERVICE_NAME", "unknown")

    async def connect(self):
        self._redis = await aioredis.from_url(
            f"redis://:{os.getenv('REDIS_PASSWORD')}@"
            f"{os.getenv('REDIS_HOST', 'redis')}:"
            f"{os.getenv('REDIS_PORT', '6379')}",
            decode_responses=True
        )
        logger.info(f"[EventBus] {self._service_name} conectado ao Redis")

    async def emit(self, event_type: EventType, payload: dict = None,
                   target: str = None, correlation_id: str = None):
        """Emite um evento. Se target=None, vai para broadcast."""
        event = Event(
            type=event_type,
            payload=payload or {},
            source=self._service_name,
            correlation_id=correlation_id
        )
        channel = f"colli:{target}" if target else self.BROADCAST_CHANNEL
        await self._redis.publish(channel, event.to_json())
        logger.info(f"[EventBus] Emitido {event_type.value} → {channel}")

    def on(self, event_type: EventType):
        """Decorator para registrar handlers de eventos."""
        def decorator(func: Callable):
            if event_type not in self._handlers:
                self._handlers[event_type] = []
            self._handlers[event_type].append(func)
            return func
        return decorator

    async def listen(self):
        """Inicia escuta nos canais deste serviço + broadcast."""
        pubsub = self._redis.pubsub()
        channels = [
            self.BROADCAST_CHANNEL,
            f"colli:{self._service_name}"
        ]
        await pubsub.subscribe(*channels)
        logger.info(f"[EventBus] Escutando canais: {channels}")

        async for message in pubsub.listen():
            if message["type"] != "message":
                continue
            try:
                event = Event.from_json(message["data"])
                handlers = self._handlers.get(event.type, [])
                for handler in handlers:
                    asyncio.create_task(handler(event))
            except Exception as e:
                logger.error(f"[EventBus] Erro processando evento: {e}")


# Instância global — importar em cada serviço
bus = EventBus()

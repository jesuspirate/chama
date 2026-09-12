"""Executable accounting model, NOT Bitcoin or Lightning software.

All keys, signatures, HTLCs, networking and chain validation are absent.
Channel updates are atomic Python operations; exits use a synthetic block clock.
"""
from dataclasses import asdict, dataclass


class Rejected(ValueError):
    pass


def integer(value, minimum=0):
    if type(value) is not int or value < minimum:
        raise Rejected(f"Expected an integer >= {minimum}")


@dataclass
class Channel:
    user: str
    operator: str
    local: int
    remote: int
    capacity: int
    state: str = "open"
    version: int = 0
    recoverable_version: int = 0
    claim_height: int | None = None
    exit_fee: int = 0


class Network:
    """Completed payments only; no in-flight HTLC or commitment protocol model."""

    def __init__(self):
        self.height = 0
        self.operators = {}
        self.channels = {}
        self.onchain = {}
        self.operator_onchain = {}
        self.fees = 0
        self.initial = 0
        self.receipts = {}

    def add_operator(self, name):
        if not isinstance(name, str) or not name or name in self.operators:
            raise Rejected("Operator must have a unique nonempty name")
        self.operators[name] = True
        self.operator_onchain[name] = 0

    def set_online(self, name, online):
        if name not in self.operators or type(online) is not bool:
            raise Rejected("Unknown operator or invalid online status")
        self.operators[name] = online

    def fund(self, user, operator, local, remote):
        """Inject explicitly counted fixture funds into an already funded channel."""
        integer(local)
        integer(remote)
        if not isinstance(user, str) or not user:
            raise Rejected("User must have a nonempty name")
        key = (user, operator)
        if operator not in self.operators or key in self.channels or local + remote == 0:
            raise Rejected("Unknown operator, duplicate channel or empty capacity")
        self.channels[key] = Channel(user, operator, local, remote, local + remote)
        self.onchain.setdefault(user, 0)
        self.initial += local + remote
        self.check()

    def channel(self, user, operator):
        try:
            return self.channels[user, operator]
        except KeyError:
            raise Rejected("No channel with this operator") from None

    def pay(self, payment_id, sender, recipient, operator, sats):
        integer(sats, 1)
        if not isinstance(payment_id, str) or not payment_id:
            raise Rejected("Payment ID required")
        request = (sender, recipient, operator, sats)
        if payment_id in self.receipts:
            if self.receipts[payment_id] != request:
                raise Rejected("Payment ID reused for different terms")
            return "already settled"
        if sender == recipient:
            raise Rejected("Sender and recipient must differ")
        if not self.operators.get(operator, False):
            raise Rejected("Operator unavailable; this route cannot settle")
        outgoing = self.channel(sender, operator)
        incoming = self.channel(recipient, operator)
        if outgoing.state != "open" or incoming.state != "open":
            raise Rejected("Route includes a closing or closed channel")
        if any(c.version != c.recoverable_version for c in (outgoing, incoming)):
            raise Rejected("Current recovery state unavailable; stop payments")
        if outgoing.local < sats:
            raise Rejected("Insufficient outbound liquidity on this route")
        if incoming.remote < sats:
            raise Rejected("Insufficient recipient inbound liquidity")
        # Abstraction of a successfully settled two-hop payment. No routing fee.
        outgoing.local -= sats
        outgoing.remote += sats
        incoming.local += sats
        incoming.remote -= sats
        for c in (outgoing, incoming):
            c.version += 1
            c.recoverable_version = c.version
        self.receipts[payment_id] = request
        self.check()
        return "settled"

    def force_close(self, user, operator, fee=500, delay=144):
        """Assume commitment inclusion now, then wait a synthetic CSV delay.

        The single fee is an illustrative total deducted from the user claim.
        Real commitment fees, dust, fee bumping and sweep outputs differ.
        """
        integer(fee)
        integer(delay, 1)
        c = self.channel(user, operator)
        if c.state != "open":
            raise Rejected("Channel is already closing or closed")
        if c.version != c.recoverable_version:
            raise Rejected("Recovery state is stale; unilateral broadcast is unsafe")
        if c.local <= fee:
            raise Rejected("Claim is uneconomic at this assumed exit fee")
        c.state = "closing"
        c.claim_height = self.height + delay
        c.exit_fee = fee
        self.check()
        return c.claim_height

    def mine(self, blocks):
        integer(blocks, 1)
        self.height += blocks

    def claim(self, user, operator):
        c = self.channel(user, operator)
        if c.state != "closing" or self.height < c.claim_height:
            raise Rejected("No matured claim")
        received = c.local - c.exit_fee
        self.onchain[user] += received
        # Operator's output is accounted here too, solely for conservation.
        self.operator_onchain[operator] += c.remote
        self.fees += c.exit_fee
        c.local = c.remote = 0
        c.state = "closed"
        self.check()
        return received

    def check(self):
        for c in self.channels.values():
            assert c.local >= 0 and c.remote >= 0
            assert c.local + c.remote == (0 if c.state == "closed" else c.capacity)
        accounted = sum(c.local + c.remote for c in self.channels.values())
        accounted += sum(self.onchain.values()) + sum(self.operator_onchain.values())
        assert accounted + self.fees == self.initial, "Value must be conserved"

    def snapshot(self):
        return {
            "height": self.height,
            "operators": dict(self.operators),
            "channels": [asdict(c) for c in self.channels.values()],
            "user_onchain_sats": dict(self.onchain),
            "operator_onchain_sats": dict(self.operator_onchain),
            "modeled_exit_fees_sats": self.fees,
            "initial_fixture_sats": self.initial,
            "settled_payments": len(self.receipts),
        }


class FederationReference:
    """Custody/availability illustration only; not Fedimint consensus or ecash."""

    def __init__(self, guardians=4, threshold=3, claim=50_000):
        integer(guardians, 1)
        integer(threshold, 1)
        integer(claim)
        if threshold > guardians:
            raise Rejected("Impossible threshold")
        self.online = guardians
        self.threshold = threshold
        self.claim = claim

    def redeem(self):
        if self.online < self.threshold:
            raise Rejected("Guardian quorum unavailable; user cannot redeem alone")
        result = self.claim
        self.claim = 0
        return result

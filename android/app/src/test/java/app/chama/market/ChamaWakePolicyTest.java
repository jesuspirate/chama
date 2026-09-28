package app.chama.market;

import org.junit.Test;
import static org.junit.Assert.*;

public class ChamaWakePolicyTest {
    @Test public void staleAndFuturePayloadsStayQuiet() {
        assertFalse(ChamaWakePolicy.fresh(0, 200_000));
        assertFalse(ChamaWakePolicy.fresh(79_999, 200_000));
        assertFalse(ChamaWakePolicy.fresh(200_001, 200_000));
        assertTrue(ChamaWakePolicy.fresh(199_000, 200_000));
    }
    @Test public void foregroundPermissionAndTestPolicy() {
        assertEquals("notifications-disabled", ChamaWakePolicy.verdict(false, false, true, false, 0, 200_000));
        assertEquals("notifications-disabled", ChamaWakePolicy.verdict(true, false, false, false, 0, 200_000));
        assertEquals("foreground", ChamaWakePolicy.verdict(true, true, true, false, 0, 200_000));
        assertEquals("shown", ChamaWakePolicy.verdict(true, false, true, false, 0, 200_000));
        assertEquals("shown", ChamaWakePolicy.verdict(true, true, true, true, 199_999, 200_000));
        assertEquals("notifications-disabled", ChamaWakePolicy.verdict(true, true, false, true, 0, 200_000));
    }
    @Test public void burstsAreLimitedPerTradeAndReason() {
        int lock = ChamaWakePolicy.notificationId("sm_a", "sm_a:locked");
        int chat = ChamaWakePolicy.notificationId("sm_a", "sm_a:chat:event1");
        int approve = ChamaWakePolicy.notificationId("sm_a", "sm_a:approved");
        int other = ChamaWakePolicy.notificationId("sm_b", "sm_b:locked");
        assertNotEquals(lock, chat);
        assertNotEquals(chat, approve);
        assertNotEquals(lock, other);
        assertEquals(chat, ChamaWakePolicy.notificationId("sm_a", "sm_a:chat:event2"));
        java.util.Map<Integer, Long> posted = new java.util.HashMap<>();
        posted.put(lock, 199_000L);
        assertEquals("rate-limited", ChamaWakePolicy.verdict(true, false, true, false, posted.get(lock), 200_000));
        for (int id : new int[] { chat, approve, other })
            assertEquals("shown", ChamaWakePolicy.verdict(true, false, true, false, posted.getOrDefault(id, 0L), 200_000));
        assertEquals("shown", ChamaWakePolicy.verdict(true, false, true, false, 195_000, 200_000));
    }
}

package app.chama.market;
import org.junit.Test;
import static org.junit.Assert.*;
public class ChamaPaymentPolicyTest {
    @Test public void onlyPaymentSchemesWithoutWhitespace() {
        assertTrue(ChamaPaymentPolicy.validUri("lightning:lnbc10n1psinvoice"));
        assertTrue(ChamaPaymentPolicy.validUri("bitcoin:bc1qsaddress?amount=0.001"));
        assertFalse(ChamaPaymentPolicy.validUri("https://example.com"));
        assertFalse(ChamaPaymentPolicy.validUri("lightning:invoice with spaces"));
        assertFalse(ChamaPaymentPolicy.validUri("bitcoin:"));
        assertFalse(ChamaPaymentPolicy.validUri(null));
    }
}

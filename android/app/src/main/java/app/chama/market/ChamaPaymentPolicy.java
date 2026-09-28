package app.chama.market;

final class ChamaPaymentPolicy {
    static boolean validUri(String uri) {
        return uri != null && uri.matches("^(lightning|bitcoin):\\S+$");
    }
}

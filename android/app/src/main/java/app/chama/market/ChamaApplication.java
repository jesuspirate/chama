package app.chama.market;

/** Capture startup and background-thread failures before any Activity exists. */
public final class ChamaApplication extends android.app.Application {
    @Override public void onCreate() {
        super.onCreate();
        Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            try {
                StackTraceElement[] stack = error.getStackTrace();
                ChamaPushStore.crash(this, error.getClass().getName(), stack.length == 0 ? "unknown" : stack[0].toString());
            } catch (Throwable ignored) { /* Never interfere with Android's crash handling. */ }
            if (previous != null) previous.uncaughtException(thread, error);
            else {
                android.os.Process.killProcess(android.os.Process.myPid());
                System.exit(10);
            }
        });
    }
}

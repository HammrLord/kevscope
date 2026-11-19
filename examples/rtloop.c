/* rtloop.c - a 1 kHz control loop plus a same-priority "logger" that hogs the CPU.
 * Build:  qcc -Vgcc_ntox86_64 -o rtloop rtloop.c      (or -Vgcc_ntoaarch64le)
 * Run:    ./rtloop &   then capture a trace with tracelogger (see codelab).
 * The logger's bursts delay the control loop: exactly what kevscope should find. */
#include <pthread.h>
#include <sched.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static void set_name_prio(const char *name, int prio) {
    struct sched_param sp = { .sched_priority = prio };
    pthread_setschedparam(pthread_self(), SCHED_FIFO, &sp);
    pthread_setname_np(pthread_self(), name);
}

static void *ctl_loop(void *arg) {
    (void)arg;
    set_name_prio("ctl_loop", 20);
    struct timespec next;
    clock_gettime(CLOCK_MONOTONIC, &next);
    volatile double x = 0;
    for (;;) {
        next.tv_nsec += 1000000; /* 1 ms period */
        if (next.tv_nsec >= 1000000000) { next.tv_nsec -= 1000000000; next.tv_sec++; }
        clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &next, NULL);
        for (int i = 0; i < 20000; i++) x += i * 0.5; /* ~100 us of control math */
    }
    return NULL;
}

static void *logger(void *arg) {
    (void)arg;
    set_name_prio("flush", 20); /* same priority + FIFO = it will not yield to ctl_loop */
    char buf[4096];
    for (;;) {
        usleep(200000);                                   /* every 200 ms ... */
        struct timespec s, n; clock_gettime(CLOCK_MONOTONIC, &s);
        do { memset(buf, 'x', sizeof buf); clock_gettime(CLOCK_MONOTONIC, &n); }
        while ((n.tv_sec - s.tv_sec) * 1000000000L + (n.tv_nsec - s.tv_nsec) < 2500000L); /* ... burn 2.5 ms */
    }
    return NULL;
}

int main(void) {
    pthread_t a, b;
    pthread_attr_t at; pthread_attr_init(&at);
    pthread_attr_setinheritsched(&at, PTHREAD_EXPLICIT_SCHED);
    pthread_create(&a, &at, ctl_loop, NULL);
    pthread_create(&b, &at, logger, NULL);
    printf("rtloop running: ctl_loop @1kHz + logger bursts\n");
    pthread_join(a, NULL);
    return 0;
}

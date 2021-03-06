#pragma once
#include <uv.h>

runtime_error uv_error(string const &context, int rc);

/*
  Calling libuv from c++ isn't all smiles and sunshine, because they store a raw function
  pointer as a callback, not a std::function. So you have to give it a non-capturing
  lambda as a uv-callback which then looks at the .data of the handle to find the full
  callback with captures.
*/

/*
  Run a job in a worker thread, then call a callback in the main loop.
  You can pass results back by casting the shared_ptr<void> to a shared_ptr<MyData>.
  The body function should set error to report a problem. If the body function throws, error is
  filled from the exception.
  The done function gets the error and result set by the body function.
*/
void uvWork(uv_loop_t *loop,
    std::function< void(string &error, shared_ptr< void > &result) > const &body,
    std::function< void(string const &error, shared_ptr< void > const &result) > const &done);

/*
  Allow any thread to schedule things to be run on the main loop. Construct one of these and call .push(f) (from
  any thread) to arrange for f to be executed next time around the main loop.
*/
struct UvAsyncQueue {
  UvAsyncQueue(uv_loop_t *_loop);
  ~UvAsyncQueue();
  UvAsyncQueue(UvAsyncQueue const &) = delete;
  UvAsyncQueue(UvAsyncQueue &&) = delete;
  UvAsyncQueue & operator = (UvAsyncQueue const &) = delete;
  UvAsyncQueue & operator = (UvAsyncQueue &&) = delete;

  void async_init();
  void push(std::function< void() > const &f);

  std::mutex workQueueMutex;
  deque< std::function< void() > > workQueue;

  uv_loop_t *loop {nullptr};
  uv_async_t *async {nullptr};
};

struct UvStream {
  UvStream(uv_loop_t *_loop);
  ~UvStream();

  void tcp_init();
  void udp_init();
  void pipe_init(int ipc=0);
  void tty_init(uv_file fd, int readable);

  void tcp_open(uv_os_sock_t sock);
  void udp_open(uv_os_sock_t sock);

  void read_start(std::function< void(size_t suggested_size, uv_buf_t *buf) > const &_alloc_cb,
                  std::function< void(ssize_t nread, uv_buf_t const *buf) > const &_read_cb);
  void read_start(std::function< void(ssize_t nread, uv_buf_t const *buf) > const &_read_cb);
  void read_stop();

  void write(string const &data, std::function< void(int) > const &_write_cb);
  void write(vector< string > const &data, std::function< void(int) > const &_write_cb);

  void tcp_connect(struct sockaddr const *addr, std::function< void(int) > const &_connect_cb);
  void tcp_bind(struct sockaddr const* addr, unsigned int flags);

  void listen_accept(int backlog, std::function<void(uv_stream_t *client, int status)> const &_listen_cb);
  void udp_bind(struct sockaddr const *addr, u_int flags=0);

  void udp_send(string const &data, struct sockaddr const *addr, std::function< void(int) > const &_cb);
  void udp_send(char const *data, size_t data_len, struct sockaddr const *addr, std::function< void(int) > const &_cb);

  void udp_recv_start(std::function< void(size_t suggested_size, uv_buf_t *buf) > const &_alloc_cb,
                      std::function< void(ssize_t nread, uv_buf_t const *buf, struct sockaddr const *addr, u_int flags) > const &_recv_cb);

  void udp_recv_start(std::function< void(ssize_t nread, uv_buf_t const *buf, struct sockaddr const *addr, u_int flags) > const &_recv_cb);

  void udp_recv_stop();

  void close();
  void shutdown(std::function< void(int) > _cb);

  bool is_active();
  bool is_closing();

  void set_send_buffer_size(int value);
  int get_send_buffer_size();

  void set_recv_buffer_size(int value);
  int get_recv_buffer_size();

  std::function<void(size_t suggested_size, uv_buf_t *buf)> read_alloc_cb;
  std::function<void(ssize_t nread, uv_buf_t const *buf)> read_cb;
  std::function<void(uv_stream_t *server, int status)> listen_cb;
  std::function<void(size_t suggested_size, uv_buf_t *buf)> recv_alloc_cb;
  std::function<void(ssize_t nread, uv_buf_t const *buf, struct sockaddr const *addr, u_int flags)> recv_cb;

  uv_loop_t *loop {nullptr};
  uv_stream_t *stream {nullptr};

};

/*
  Resolve a DNS name asynchronously. Supply hostname, portname, hints and it'll call cb with a status code and
  an addrinfo * (nullptr if it failed). The addrinfo is freed after the callback returns.
*/
void UvGetAddrInfo(uv_loop_t *loop, string const &hostname, string const &portname, struct addrinfo const &hints, std::function<void(int, struct addrinfo *)> const &_cb);

struct UvProcess {

  UvProcess(uv_loop_t *_loop,
    string const &file, vector< string > const &args, vector< string > const &env,
    UvStream *stdin_pipe,
    UvStream *stdout_pipe,
    UvStream *stderr_pipe,
    std::function< void(int64_t exit_status, int term_signal) > _exit_cb);

  uv_loop_t *loop;
  std::function< void(int64_t exit_status, int term_signal) > exit_cb;
  uv_process_t proc;
  bool running {false};

};


struct UvTimer {
  UvTimer(uv_loop_t *_loop);
  UvTimer();
  ~UvTimer();

  uv_loop_t *loop {nullptr};
  uv_timer_t *timer {nullptr};
  std::function< void() > cb;

  bool is_active();
  void timer_init();
  void timer_start(std::function< void() > _cb, uint64_t timeout, uint64_t repeat);
  void timer_again();
  void timer_set_repeat(uint64_t repeat);
  uint64_t timer_get_repeat();
  void timer_stop();
  void close();

};

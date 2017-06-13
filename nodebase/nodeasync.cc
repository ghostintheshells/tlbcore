#include "../common/std_headers.h"
#include "../common/jsonio.h"
#include "./jswrapbase.h"
#include "./nodeasync.h"
#include <mutex>
#include <uv.h>
using namespace v8;

struct AsyncEventQueueImpl : AsyncEventQueueApi {

  AsyncEventQueueImpl(AsyncCallbacks *_owner);
  ~AsyncEventQueueImpl();

  void start();
  void push(string const &eventName, jsonstr const &it);
  void deliver_queued();
  void on(string const &eventName, Local<Value> cb);

  void sync_emit(string const &eventName, Local<Value> arg);
  void sync_emit(string const &eventName);

  AsyncCallbacks *owner;
  uv_async_t uva;
  std::mutex qMutex;
  deque< pair<string, jsonstr> > q;
  std::unordered_map< string, vector< shared_ptr< Persistent<Function> > > > nameToCbs;
};



void AsyncCallbacks::on(string const &eventName, Local<Value> _onMessage)
{
  call_once(implInitOnce, [this]() {
    impl = make_shared<AsyncEventQueueImpl>(this);
    impl->start();
  });
  impl->on(eventName, _onMessage);
}



void AsyncCallbacks::sync_emit(string const &eventName, Local<Value> arg)
{
  if (impl) {
    impl->sync_emit(eventName, arg);
  }
}


// -----------------------

AsyncEventQueueImpl::AsyncEventQueueImpl(AsyncCallbacks *_owner)
  :owner(_owner)
{
  if (0) eprintf("AsyncEventQueueImpl constructor\n");
  uva.data = nullptr;
}

AsyncEventQueueImpl::~AsyncEventQueueImpl()
{
  if (1) eprintf("AsyncEventQueueImpl destructor\n");
  if (uva.data) {
    uva.data = nullptr;
    uv_close((uv_handle_t *)&uva, [](uv_handle_t *uva1) {
      if (1) eprintf("AsyncEventQueueImpl destructor close callback\n");
      // ???
    });
  }
  owner = nullptr;
}

void AsyncEventQueueImpl::start()
{
  assert(uva.data == nullptr);

  uva.data = (void *)this;
  uv_loop_t *loop = uv_default_loop();

  uv_async_init(loop, &uva, [](uv_async_t* uva1) {
    auto self = reinterpret_cast<AsyncEventQueueImpl*>(uva1->data);
    self->deliver_queued();
  });
  uv_unref((uv_handle_t *)&uva);
}

void AsyncEventQueueImpl::deliver_queued()
{
  /*
    This part gets called from the uv event loop, when it should be OK to call v8 ops.
  */
  Isolate *isolate = Isolate::GetCurrent();
  HandleScope scope(isolate);

  Local<Value> recvLocal = Undefined(isolate);

  while (1) {
    unique_lock<mutex> lock(qMutex);
    if (q.empty()) break;
    auto &msg = q.front();
    auto &cbs = nameToCbs[msg.first];
    if (!cbs.size()) {
      // shortcut to avoid even json-decoding when no callbacks
      q.pop_front();
      continue;
    }
    Local<Value> jsMsg = convJsonstrToJs(isolate, msg.second);
    q.pop_front(); // Can't use msg after this
    lock.unlock();

    for (auto &cb : cbs) {
      Local<Function> cbLocal = Local<Function>::New(isolate, *cb);
      // WRITEME: should we handle blobs somewhere?
      cbLocal->Call(recvLocal, 1, &jsMsg);
    }
  }
}

void AsyncEventQueueImpl::sync_emit(string const &eventName, Local<Value> arg)
{
  Isolate *isolate = Isolate::GetCurrent();
  HandleScope scope(isolate);

  Local<Value> recvLocal = Undefined(isolate);

  auto &cbs = nameToCbs[eventName];

  for (auto &cb : cbs) {
    Local<Function> cbLocal = Local<Function>::New(isolate, *cb);
    // WRITEME: should we handle blobs somewhere?
    cbLocal->Call(recvLocal, 1, &arg);
  }
}

void AsyncEventQueueImpl::sync_emit(string const &eventName)
{
  Isolate *isolate = Isolate::GetCurrent();
  HandleScope scope(isolate);

  Local<Value> recvLocal = Undefined(isolate);

  auto &cbs = nameToCbs[eventName];

  for (auto &cb : cbs) {
    Local<Function> cbLocal = Local<Function>::New(isolate, *cb);
    cbLocal->Call(recvLocal, 0, nullptr);
  }
}


void AsyncEventQueueImpl::on(string const &eventName, Local<Value> cb)
{
  Isolate *isolate = Isolate::GetCurrent();
  HandleScope scope(isolate);

  shared_ptr< Persistent<Function> > cbPersistent = make_shared< Persistent<Function> >();
  cbPersistent->Reset(isolate, Local<Function>::Cast(cb));
  unique_lock<mutex> lock(qMutex);
  nameToCbs[eventName].push_back(cbPersistent);
}

void AsyncEventQueueImpl::push(string const &eventName, jsonstr const &json)
{
  unique_lock<mutex> lock(qMutex);
  q.push_back(make_pair(eventName, json));
  lock.unlock();
  uv_async_send(&uva);
}

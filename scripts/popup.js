function save_options() {
  var defaultBlog = document.getElementById('default-blog').value;
  var reblogBehavior = document.getElementById('reblog-behavior').value;

  var queueBehavior = false;
  if(document.getElementById('queue-behavior').value == "yes")
    queueBehavior = true;

  chrome.storage.sync.set({
    defaultBlog: parseInt(defaultBlog),
    reblogBehavior: reblogBehavior,
    queueBehavior: queueBehavior
  }, function() {
    $("#options-status").css("display", "block").text("Options saved.");
    setTimeout(function() {
      $("#options-status").css("display", "none").text("");
    }, 2000);
    chrome.tabs.reload();
  });
}

function retrieve_options() {
  chrome.storage.sync.get({
    defaultBlog: 0,
    reblogBehavior: "post",
    queueBehavior: false
  }, function(items) {
    document.getElementById('default-blog').value = items.defaultBlog;
    document.getElementById('reblog-behavior').value = items.reblogBehavior;
    var queueBehaviorStr = "no";
    if(items.queueBehavior)
      queueBehaviorStr = "yes";
    document.getElementById('queue-behavior').value = queueBehaviorStr;
  });
}

$(document).ready(retrieve_options);
$("#save-options").click(save_options);

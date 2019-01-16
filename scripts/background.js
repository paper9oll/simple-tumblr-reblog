chrome.tabs.onUpdated.addListener(function(id, info, tab) {
  if(tab.url.match('http://.*.tumblr.com/.*' && 'https://.*.tumblr.com/.*')) {
    chrome.pageAction.show(tab.id);
  }
});

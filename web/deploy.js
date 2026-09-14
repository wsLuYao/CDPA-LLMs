(function () {
  "use strict";

  var storageKey = "cdpa_deploy_progress";
  var domainInput = document.getElementById("deployDomain");
  var ipInput = document.getElementById("deployIp");
  var emailInput = document.getElementById("deployEmail");
  var checks = Array.from(document.querySelectorAll("[data-deploy-check]"));
  var acceptance = Array.from(document.querySelectorAll("[data-acceptance]"));
  var toastTimer = 0;

  function cleanDomain(value) {
    return String(value || "").trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "") || "assessment.example.com";
  }

  function cleanIp(value) {
    return String(value || "").trim() || "203.0.113.10";
  }

  function hostRecord(domain) {
    var parts = domain.split(".");
    return parts.length > 2 ? parts[0] : "@";
  }

  function replaceTemplate(value) {
    return value.replace(/\{\{DOMAIN\}\}/g, cleanDomain(domainInput.value)).replace(/\{\{IP\}\}/g, cleanIp(ipInput.value));
  }

  function updateGeneratedContent() {
    var domain = cleanDomain(domainInput.value);
    var ip = cleanIp(ipInput.value);
    document.getElementById("dnsHost").textContent = hostRecord(domain);
    document.getElementById("dnsValue").textContent = ip;
    document.getElementById("answerDomain").textContent = domain;
    document.getElementById("answerEmail").textContent = String(emailInput.value || "").trim() || "admin@example.com";
    document.getElementById("openDeployedSite").href = "https://" + domain;
    document.querySelectorAll("[data-command-template]").forEach(function (element) {
      element.textContent = replaceTemplate(element.getAttribute("data-command-template") || "");
    });
  }

  function storedState() {
    try {
      return JSON.parse(localStorage.getItem(storageKey) || "{}");
    } catch (error) {
      return {};
    }
  }

  function saveState() {
    var state = {};
    checks.forEach(function (check) {
      state[check.getAttribute("data-deploy-check")] = check.checked;
    });
    try {
      localStorage.setItem(storageKey, JSON.stringify(state));
    } catch (error) {
      return;
    }
  }

  function updateProgress() {
    var complete = checks.filter(function (check) { return check.checked; }).length;
    document.getElementById("deployProgressText").textContent = complete + " / " + checks.length;
    document.getElementById("deployProgressBar").style.width = Math.round(complete / checks.length * 100) + "%";
    var notes = [
      "先填写域名和公网 IP，后面的命令会自动替换。",
      "下一步：在你选择的云服务商创建 Linux 云服务器。",
      "下一步：设置安全组，只开放必要端口。",
      "下一步：让域名 A 记录指向服务器。",
      "下一步：通过 FinalShell 或 SSH 上传部署包。",
      "下一步：安装 Docker Engine 与 Compose。",
      "下一步：运行 setup.sh 自动配置并启动。",
      "下一步：检查 HTTPS、账号和演示报告。",
      "部署清单已全部完成，记得定期运行 backup.sh。"
    ];
    document.getElementById("deployProgressNote").textContent = notes[complete];
    checks.forEach(function (check) {
      var section = check.closest(".deploy-step");
      if (section) section.classList.toggle("is-complete", check.checked);
      var key = check.getAttribute("data-deploy-check");
      var nav = document.querySelector('#deployNav a[href="#step-' + key + '"]');
      if (nav) nav.classList.toggle("is-done", check.checked);
    });
  }

  function showToast(message) {
    var toast = document.getElementById("deployToast");
    toast.textContent = message;
    toast.classList.add("show");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () { toast.classList.remove("show"); }, 1800);
  }

  function fallbackCopy(value) {
    var area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }

  document.querySelectorAll("[data-copy-target]").forEach(function (button) {
    button.addEventListener("click", function () {
      var target = document.getElementById(button.getAttribute("data-copy-target"));
      var value = target ? target.textContent.trim() : "";
      var promise = navigator.clipboard && window.isSecureContext ? navigator.clipboard.writeText(value) : null;
      if (promise) {
        promise.then(function () { showToast("命令已复制"); }).catch(function () {
          fallbackCopy(value);
          showToast("命令已复制");
        });
      } else {
        fallbackCopy(value);
        showToast("命令已复制");
      }
    });
  });

  [domainInput, ipInput, emailInput].forEach(function (input) {
    input.addEventListener("input", updateGeneratedContent);
  });

  var state = storedState();
  checks.forEach(function (check) {
    check.checked = Boolean(state[check.getAttribute("data-deploy-check")]);
    check.addEventListener("change", function () {
      saveState();
      updateProgress();
    });
  });

  document.getElementById("resetDeployProgress").addEventListener("click", function () {
    checks.forEach(function (check) { check.checked = false; });
    acceptance.forEach(function (check) { check.checked = false; });
    try {
      localStorage.removeItem(storageKey);
    } catch (error) {
      // 勾选状态仍会在当前页面重置。
    }
    updateProgress();
    showToast("进度已重置");
  });

  acceptance.forEach(function (check) {
    check.addEventListener("change", function () {
      var verify = document.querySelector('[data-deploy-check="verify"]');
      if (acceptance.every(function (item) { return item.checked; })) {
        verify.checked = true;
        saveState();
        updateProgress();
      }
    });
  });

  var navLinks = Array.from(document.querySelectorAll("#deployNav a"));
  if ("IntersectionObserver" in window) {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        navLinks.forEach(function (link) {
          link.classList.toggle("is-current", link.getAttribute("href") === "#" + entry.target.id);
        });
      });
    }, {rootMargin: "-25% 0px -65% 0px"});
    document.querySelectorAll(".deploy-step").forEach(function (section) { observer.observe(section); });
  }

  updateGeneratedContent();
  updateProgress();
}());

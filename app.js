// Stock Portfolio Tracker - Application Logic

// State variables
let transactions = [];
let prices = {};
let portfolioSummary = {};
let stockHoldings = {};
let loanConfig = {};

// Default prices (last transaction prices as starting points)
const DEFAULT_PRICES = {
  "元大台灣50": 104.5,
  "富邦台50": 242.0,
  "元大S&P500": 74.7,
  "富邦NASDAQ": 122.0
};

// Chart instances
let allocationChart = null;
let pnlChart = null;

// Live price fetch state
let priceAutoRefreshTimer = null;
let lastPriceFetchTime = null;
let isPriceFetching = false;

// TWSE stock code mapping (stockName -> TWSE code with exchange prefix)
const STOCK_TWSE_MAP = {
  "元大台灣50":  "tse_0050.tw",
  "富邦台50":    "tse_006208.tw",
  "元大S&P500": "tse_00646.tw",
  "富邦NASDAQ": "tse_00662.tw"
};


// Initialize Application
document.addEventListener("DOMContentLoaded", () => {
  loadData();
  initEventListeners();
  renderApp();

  // Detect file:// protocol and warn user
  if (location.protocol === 'file:') {
    showToast('⚠️ 請使用本地伺服器開啟（右鍵 start-server.ps1 → 使用 PowerShell 執行），`file://` 無法即時更新股價', 'danger');
    document.getElementById('live-price-label').textContent = '請用伺服器開啟';
    document.getElementById('live-price-label').style.color = '#ef4444';
    document.getElementById('live-price-indicator').textContent = '⚠️';
  }

  // Fetch live prices on startup and start auto-refresh
  fetchLivePrices();
  startPriceAutoRefresh();
});

// Load data from LocalStorage or fall back to defaults
function loadData() {
  const savedVersion = localStorage.getItem("portfolio_data_version");
  const savedTransactions = localStorage.getItem("portfolio_transactions");
  const savedPrices = localStorage.getItem("portfolio_prices");
  const savedLoanConfig = localStorage.getItem("portfolio_loan_config");

  // DATA_VERSION comes from data.js; if it changed (新交易加入), reload defaults
  if (savedVersion !== String(DATA_VERSION) || !savedTransactions) {
    transactions = [...INITIAL_TRANSACTIONS];
    prices = { ...DEFAULT_PRICES };
    loanConfig = {
      baseAmount: 1597333,
      baseDate: "2026-06-02",
      monthlyDeduction: 22000,
      deductionDay: 2
    };
    saveTransactionsToLocalStorage();
    savePricesToLocalStorage();
    saveLoanConfigToLocalStorage();
    localStorage.setItem("portfolio_data_version", String(DATA_VERSION));
    return;
  }

  if (savedTransactions) {
    transactions = JSON.parse(savedTransactions);
  }
  if (savedPrices) {
    prices = JSON.parse(savedPrices);
  } else {
    prices = { ...DEFAULT_PRICES };
    savePricesToLocalStorage();
  }
  if (savedLoanConfig) {
    loanConfig = JSON.parse(savedLoanConfig);
  }

  if (savedPrices) {
    prices = JSON.parse(savedPrices);
  } else {
    prices = { ...DEFAULT_PRICES };
    savePricesToLocalStorage();
  }

  if (savedLoanConfig) {
    loanConfig = JSON.parse(savedLoanConfig);
  } else {
    loanConfig = {
      baseAmount: 1597333,
      baseDate: "2026-06-02",
      monthlyDeduction: 22000,
      deductionDay: 2
    };
    saveLoanConfigToLocalStorage();
  }
}

function saveTransactionsToLocalStorage() {
  localStorage.setItem("portfolio_transactions", JSON.stringify(transactions));
}

function savePricesToLocalStorage() {
  localStorage.setItem("portfolio_prices", JSON.stringify(prices));
}

function saveLoanConfigToLocalStorage() {
  localStorage.setItem("portfolio_loan_config", JSON.stringify(loanConfig));
}

// Calculate portfolio metrics chronologically
function calculatePortfolio() {
  stockHoldings = {};
  
  // Sort transactions chronologically: Date ascending
  // Format is "115/MM/DD", we can sort them lexicographically or parse them
  const sortedTransactions = [...transactions].sort((a, b) => {
    const parseDate = (dStr) => {
      const parts = dStr.split('/');
      const year = parseInt(parts[0]) + 1911; // convert Minguo year to Gregorian
      const month = parseInt(parts[1]) - 1;
      const day = parseInt(parts[2]);
      return new Date(year, month, day).getTime();
    };
    
    const timeA = parseDate(a.date);
    const timeB = parseDate(b.date);
    
    if (timeA !== timeB) return timeA - timeB;
    // Keep stable order using original array indices if dates are identical
    return transactions.indexOf(a) - transactions.indexOf(b);
  });

  // Calculate holdings
  sortedTransactions.forEach(t => {
    const name = t.name;
    if (!stockHoldings[name]) {
      stockHoldings[name] = {
        name: name,
        shares: 0,
        totalCost: 0, // Cost basis of current holdings
        realizedPnL: 0,
        totalBoughtShares: 0,
        totalBoughtAmount: 0,
        totalSoldShares: 0,
        totalSoldAmount: 0
      };
    }

    const h = stockHoldings[name];
    const rawAmount = t.shares * t.price;
    
    if (t.type === "buy") {
      // For buys: Net Payment = Amount + Fee.
      // We use t.net if available, otherwise calculate it
      const netCost = t.net || (rawAmount + t.fee);
      h.shares += t.shares;
      h.totalCost += netCost;
      h.totalBoughtShares += t.shares;
      h.totalBoughtAmount += netCost;
    } else if (t.type === "sell") {
      // For sells: Net Payment = Amount - Fee - Tax
      const netRevenue = t.net || (rawAmount - t.fee - t.tax);
      
      const avgCostBefore = h.shares > 0 ? (h.totalCost / h.shares) : 0;
      const soldShares = t.shares;
      const costOfSold = avgCostBefore * soldShares;
      
      const pnl = netRevenue - costOfSold;
      
      h.realizedPnL += pnl;
      h.shares -= soldShares;
      h.totalCost -= costOfSold;
      
      h.totalSoldShares += soldShares;
      h.totalSoldAmount += netRevenue;

      // Handle float rounding issues
      if (h.shares <= 0) {
        h.shares = 0;
        h.totalCost = 0;
      }
    }
  });

  // Calculate unrealized P&L and totals
  let totalInvested = 0;
  let totalValue = 0;
  let totalUnrealizedPnL = 0;
  let totalRealizedPnL = 0;

  Object.keys(stockHoldings).forEach(name => {
    const h = stockHoldings[name];
    if (h.shares > 0) {
      h.currentPrice = prices[name] || 0;
      h.marketValue = h.shares * h.currentPrice;
      h.unrealizedPnL = h.marketValue - h.totalCost;
      h.avgPrice = h.totalCost / h.shares;
      
      totalInvested += h.totalCost;
      totalValue += h.marketValue;
      totalUnrealizedPnL += h.unrealizedPnL;
    } else {
      h.currentPrice = prices[name] || 0;
      h.marketValue = 0;
      h.unrealizedPnL = 0;
      h.avgPrice = 0;
    }
    totalRealizedPnL += h.realizedPnL;
  });

  const totalNetProfit = totalUnrealizedPnL + totalRealizedPnL;
  const overallRoi = totalInvested > 0 ? (totalUnrealizedPnL / totalInvested) * 100 : 0;

  portfolioSummary = {
    totalInvested,
    totalValue,
    totalUnrealizedPnL,
    totalRealizedPnL,
    totalNetProfit,
    overallRoi
  };
}

// Render the entire application UI
function renderApp() {
  calculatePortfolio();
  renderSummaryCards();
  renderHoldingsTable();
  renderPriceInputs();
  renderLoanInputs();
  renderTransactionsTable();
  renderCharts();
}

// Render top summary statistics cards
function renderSummaryCards() {
  document.getElementById("total-invested").innerText = formatCurrency(portfolioSummary.totalInvested);
  document.getElementById("total-value").innerText = formatCurrency(portfolioSummary.totalValue);
  
  const pnlEl = document.getElementById("total-pnl");
  const pnlPercentEl = document.getElementById("total-pnl-percent");
  const pnlCardEl = document.getElementById("pnl-card");
  
  const netProfit = portfolioSummary.totalNetProfit;
  const unrealizedRoi = portfolioSummary.overallRoi;
  
  pnlEl.innerText = formatCurrencyWithSign(netProfit);
  pnlPercentEl.innerHTML = `${netProfit >= 0 ? '▲' : '▼'} ${unrealizedRoi.toFixed(2)}% (帳面獲利比)`;

  // Add color classes
  pnlEl.className = `card-value-display ${netProfit >= 0 ? 'text-profit' : 'text-loss'}`;
  pnlPercentEl.className = `card-trend ${netProfit >= 0 ? 'bg-profit' : 'bg-loss'}`;
  
  if (netProfit >= 0) {
    pnlCardEl.classList.remove("negative");
  } else {
    pnlCardEl.classList.add("negative");
  }

  // Realized and Unrealized Breakdowns
  document.getElementById("unrealized-pnl-breakdown").innerText = `未實現: ${formatCurrencyWithSign(portfolioSummary.totalUnrealizedPnL)}`;
  document.getElementById("realized-pnl-breakdown").innerText = `已實現: ${formatCurrencyWithSign(portfolioSummary.totalRealizedPnL)}`;

  // Leverage ratio card updates
  const loanInfo = calculateLoanBalance();
  const actualCapital = Math.max(0, portfolioSummary.totalInvested - loanInfo.currentBalance);
  const leverage = actualCapital > 0 ? (portfolioSummary.totalValue / actualCapital) : 1;

  document.getElementById("loan-balance-display").innerText = `信貸餘額: ${formatCurrency(loanInfo.currentBalance)}`;
  document.getElementById("leverage-subtext").innerText = `實際本金: ${formatCurrency(actualCapital)}`;
  
  const ratioEl = document.getElementById("leverage-ratio");
  ratioEl.innerText = `${leverage.toFixed(2)}x`;
  
  if (leverage > 2.0) {
    ratioEl.className = "card-value-display text-loss";
  } else if (leverage > 1.0) {
    ratioEl.className = "card-value-display text-profit";
  } else {
    ratioEl.className = "card-value-display";
  }
}

// Render the Holdings Table
function renderHoldingsTable() {
  const tbody = document.getElementById("holdings-table-body");
  tbody.innerHTML = "";

  const activeHoldings = Object.values(stockHoldings).filter(h => h.shares > 0 || h.realizedPnL !== 0);

  if (activeHoldings.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" class="no-data-msg">暫無持股資料</td></tr>`;
    return;
  }

  activeHoldings.forEach(h => {
    const roi = h.totalCost > 0 ? (h.unrealizedPnL / h.totalCost) * 100 : 0;
    const netProfit = h.unrealizedPnL + h.realizedPnL;
    
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>
        <div class="stock-badge">
          <span style="width: 8px; height: 8px; border-radius: 50%; background: ${getStockColor(h.name)}"></span>
          ${h.name}
        </div>
      </td>
      <td>${formatNumber(h.shares)} 股</td>
      <td>$${formatDecimal(h.avgPrice, 2)}</td>
      <td>
        <span class="price-click-edit" onclick="focusPriceInput('${h.name}')">$${formatDecimal(h.currentPrice, 2)}</span>
      </td>
      <td>$${formatNumber(Math.round(h.marketValue))}</td>
      <td class="${h.unrealizedPnL >= 0 ? 'text-profit' : 'text-loss'}">
        ${formatCurrencyWithSign(h.unrealizedPnL)}
        <div style="font-size: 11px; margin-top: 2px;">
          ${h.totalCost > 0 ? (roi >= 0 ? '+' : '') + roi.toFixed(2) + '%' : '0.00%'}
        </div>
      </td>
      <td class="${h.realizedPnL >= 0 ? 'text-profit' : 'text-loss'}">
        ${formatCurrencyWithSign(h.realizedPnL)}
      </td>
      <td class="${netProfit >= 0 ? 'text-profit' : 'text-loss'}" style="font-weight: 700;">
        ${formatCurrencyWithSign(netProfit)}
      </td>
      <td>
        <button class="btn btn-secondary btn-sm" onclick="openAddTransactionModal('${h.name}')">交易</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  // Render total summary row
  const sumRow = document.createElement("tr");
  sumRow.className = "table-summary-row";
  
  const totalNet = portfolioSummary.totalUnrealizedPnL + portfolioSummary.totalRealizedPnL;
  const totalRoi = portfolioSummary.totalInvested > 0 ? (portfolioSummary.totalUnrealizedPnL / portfolioSummary.totalInvested) * 100 : 0;

  sumRow.innerHTML = `
    <td>總計</td>
    <td>-</td>
    <td>-</td>
    <td>-</td>
    <td>$${formatNumber(Math.round(portfolioSummary.totalValue))}</td>
    <td class="${portfolioSummary.totalUnrealizedPnL >= 0 ? 'text-profit' : 'text-loss'}">
      ${formatCurrencyWithSign(portfolioSummary.totalUnrealizedPnL)}
      <div style="font-size: 11px; margin-top: 2px;">
        ${totalRoi >= 0 ? '+' : ''}${totalRoi.toFixed(2)}%
      </div>
    </td>
    <td class="${portfolioSummary.totalRealizedPnL >= 0 ? 'text-profit' : 'text-loss'}">
      ${formatCurrencyWithSign(portfolioSummary.totalRealizedPnL)}
    </td>
    <td class="${totalNet >= 0 ? 'text-profit' : 'text-loss'}">
      ${formatCurrencyWithSign(totalNet)}
    </td>
    <td>-</td>
  `;
  tbody.appendChild(sumRow);
}

// Render side panel for updating current stock prices
function renderPriceInputs() {
  const container = document.getElementById("price-inputs-container");
  container.innerHTML = "";

  const uniqueStocks = getUniqueStockNames();
  
  uniqueStocks.forEach(name => {
    const h = stockHoldings[name] || { shares: 0 };
    const row = document.createElement("div");
    row.className = "price-input-row";
    row.innerHTML = `
      <div class="price-stock-info">
        <span class="price-stock-name">${name}</span>
        <span class="price-stock-shares">庫存: ${formatNumber(h.shares || 0)} 股</span>
      </div>
      <div class="price-input-wrapper">
        <span class="price-currency">NT$</span>
        <input type="number" step="0.01" class="price-num-input" 
               id="price-input-${name}" 
               value="${prices[name] || 0}" 
               onchange="updateStockPrice('${name}', this.value)">
      </div>
    `;
    container.appendChild(row);
  });
}

function focusPriceInput(name) {
  const input = document.getElementById(`price-input-${name}`);
  if (input) {
    input.focus();
    input.select();
  }
}

function updateStockPrice(name, value) {
  const numVal = parseFloat(value) || 0;
  prices[name] = numVal;
  savePricesToLocalStorage();
  renderApp();
  showToast(`已更新 ${name} 現價至 $${numVal.toFixed(2)}`, "success");
}

// Get unique stock names present in transactions
function getUniqueStockNames() {
  const names = new Set(transactions.map(t => t.name));
  // Keep order consistent: 0050, 006208, 00646, 00662 first if present, then others
  const order = ["元大台灣50", "富邦台50", "元大S&P500", "富邦NASDAQ"];
  const result = [];
  
  order.forEach(o => {
    if (names.has(o)) {
      result.push(o);
      names.delete(o);
    }
  });
  
  // Append any other stock names
  names.forEach(n => result.push(n));
  return result;
}

// Render Transactions Table with filters
function renderTransactionsTable() {
  const tbody = document.getElementById("transactions-table-body");
  tbody.innerHTML = "";

  const searchTerm = document.getElementById("search-tx").value.toLowerCase();
  const filterStock = document.getElementById("filter-stock").value;
  const filterType = document.getElementById("filter-type").value;

  // Filter stock select options population
  populateFilterSelect();

  let filtered = transactions.filter(t => {
    const matchesSearch = t.name.toLowerCase().includes(searchTerm) || 
                          (t.ref && t.ref.toLowerCase().includes(searchTerm)) ||
                          t.date.includes(searchTerm);
    const matchesStock = filterStock === "" || t.name === filterStock;
    const matchesType = filterType === "" || t.type === filterType;
    return matchesSearch && matchesStock && matchesType;
  });

  // Sort descending by date (newest first)
  filtered.sort((a, b) => {
    const parseDate = (dStr) => {
      const parts = dStr.split('/');
      const year = parseInt(parts[0]) + 1911;
      const month = parseInt(parts[1]) - 1;
      const day = parseInt(parts[2]);
      return new Date(year, month, day).getTime();
    };
    const timeA = parseDate(a.date);
    const timeB = parseDate(b.date);
    
    if (timeA !== timeB) return timeB - timeA;
    return transactions.indexOf(b) - transactions.indexOf(a);
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" class="no-data-msg">沒有符合篩選條件的交易紀錄</td></tr>`;
    return;
  }

  filtered.forEach(t => {
    const rawVal = t.shares * t.price;
    const net = t.net || (t.type === 'buy' ? rawVal + t.fee : rawVal - t.fee - t.tax);
    
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${t.date}</td>
      <td>
        <span class="action-badge ${t.type === 'buy' ? 'action-buy' : 'action-sell'}">
          ${t.type === 'buy' ? '買進' : '賣出'}
        </span>
      </td>
      <td style="font-weight: 600;">${t.name}</td>
      <td>${formatNumber(t.shares)} 股</td>
      <td>$${formatDecimal(t.price, 2)}</td>
      <td>$${formatNumber(t.fee)}</td>
      <td>$${formatNumber(t.tax || 0)}</td>
      <td style="font-weight: 600;">$${formatNumber(Math.round(net))}</td>
      <td>
        <div class="action-cell">
          <button class="btn-icon edit" onclick="openEditTransactionModal(${transactions.indexOf(t)})" title="編輯">
            ✎
          </button>
          <button class="btn-icon delete" onclick="deleteTransaction(${transactions.indexOf(t)})" title="刪除">
            🗑
          </button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function populateFilterSelect() {
  const select = document.getElementById("filter-stock");
  const currentVal = select.value;
  
  select.innerHTML = '<option value="">所有標的</option>';
  
  const uniqueStocks = getUniqueStockNames();
  uniqueStocks.forEach(name => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    if (name === currentVal) {
      opt.selected = true;
    }
    select.appendChild(opt);
  });
}

// Charts rendering (Allocation & P&L comparisons)
function renderCharts() {
  // 1. Doughnut Chart: Portfolio Allocation
  const allocationCtx = document.getElementById("allocationChart").getContext("2d");
  
  const labels = [];
  const values = [];
  const backgroundColors = [];
  
  Object.values(stockHoldings).forEach(h => {
    if (h.shares > 0) {
      labels.push(h.name);
      values.push(Math.round(h.marketValue));
      backgroundColors.push(getStockColor(h.name));
    }
  });

  if (allocationChart) {
    allocationChart.destroy();
  }

  if (values.length === 0) {
    document.getElementById("allocationChart").style.display = "none";
    document.getElementById("chart-no-data").style.display = "block";
  } else {
    document.getElementById("allocationChart").style.display = "block";
    document.getElementById("chart-no-data").style.display = "none";
    
    allocationChart = new Chart(allocationCtx, {
      type: "doughnut",
      data: {
        labels: labels,
        datasets: [{
          data: values,
          backgroundColor: backgroundColors,
          borderWidth: 1,
          borderColor: "rgba(255, 255, 255, 0.1)"
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: "right",
            labels: {
              color: "#94a3b8",
              font: {
                family: "Plus Jakarta Sans",
                size: 12
              }
            }
          },
          tooltip: {
            callbacks: {
              label: function(context) {
                const val = context.raw;
                const sum = context.dataset.data.reduce((a, b) => a + b, 0);
                const percent = ((val / sum) * 100).toFixed(1);
                return ` ${context.label}: NT$${formatNumber(val)} (${percent}%)`;
              }
            }
          }
        },
        cutout: "65%"
      }
    });
  }

  // 2. Bar Chart: Cost Basis vs Market Value
  const pnlCtx = document.getElementById("pnlChart").getContext("2d");
  
  const barLabels = [];
  const costValues = [];
  const marketValues = [];

  Object.values(stockHoldings).forEach(h => {
    if (h.shares > 0) {
      barLabels.push(h.name);
      costValues.push(Math.round(h.totalCost));
      marketValues.push(Math.round(h.marketValue));
    }
  });

  if (pnlChart) {
    pnlChart.destroy();
  }

  if (barLabels.length === 0) {
    document.getElementById("pnlChart").style.display = "none";
    document.getElementById("pnl-chart-no-data").style.display = "block";
  } else {
    document.getElementById("pnlChart").style.display = "block";
    document.getElementById("pnl-chart-no-data").style.display = "none";

    pnlChart = new Chart(pnlCtx, {
      type: "bar",
      data: {
        labels: barLabels,
        datasets: [
          {
            label: "投資成本",
            data: costValues,
            backgroundColor: "rgba(79, 70, 229, 0.8)",
            borderRadius: 6
          },
          {
            label: "當前市值",
            data: marketValues,
            backgroundColor: "rgba(6, 182, 212, 0.8)",
            borderRadius: 6
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: "#94a3b8" }
          },
          y: {
            grid: { color: "rgba(255, 255, 255, 0.05)" },
            ticks: {
              color: "#94a3b8",
              callback: value => `$${formatNumber(value)}`
            }
          }
        },
        plugins: {
          legend: {
            position: "top",
            labels: { color: "#94a3b8" }
          }
        }
      }
    });
  }
}

// Helpers for Colors
function getStockColor(name) {
  const colors = {
    "元大台灣50": "#4f46e5",   // Indigo
    "富邦台50": "#10b981",     // Emerald Green
    "元大S&P500": "#f59e0b",   // Orange/Amber
    "富邦NASDAQ": "#06b6d4"    // Cyan
  };
  return colors[name] || "#8b5cf6"; // Violet fallback
}

// Formatter Helpers
function formatNumber(num) {
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatDecimal(num, decimals = 2) {
  return parseFloat(num).toFixed(decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatCurrency(num) {
  return `NT$ ${formatNumber(Math.round(num))}`;
}

function formatCurrencyWithSign(num) {
  const rounded = Math.round(num);
  if (rounded > 0) {
    return `+$${formatNumber(rounded)}`;
  } else if (rounded < 0) {
    return `-$${formatNumber(Math.abs(rounded))}`;
  } else {
    return `$0`;
  }
}

// Modal handling
let editingTransactionIndex = -1;

function openAddTransactionModal(defaultStockName = "") {
  editingTransactionIndex = -1;
  document.getElementById("modal-title").innerText = "新增交易紀錄";
  
  // Reset form
  const form = document.getElementById("transaction-form");
  form.reset();

  // Set default date to today in Minguo format, e.g. "115/06/29"
  const now = new Date();
  const minguoYear = now.getFullYear() - 1911;
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  document.getElementById("tx-date").value = `${minguoYear}/${mm}/${dd}`;

  if (defaultStockName) {
    document.getElementById("tx-name").value = defaultStockName;
  }

  // Bind calculation preview
  setupAutoCalculations();

  document.getElementById("tx-modal").classList.add("active");
}

function openEditTransactionModal(index) {
  editingTransactionIndex = index;
  document.getElementById("modal-title").innerText = "編輯交易紀錄";

  const t = transactions[index];
  
  document.getElementById("tx-date").value = t.date;
  document.getElementById("tx-type").value = t.type;
  document.getElementById("tx-name").value = t.name;
  document.getElementById("tx-shares").value = t.shares;
  document.getElementById("tx-price").value = t.price;
  document.getElementById("tx-fee").value = t.fee;
  document.getElementById("tx-tax").value = t.tax || 0;

  setupAutoCalculations();
  updateModalCalcPreview();

  document.getElementById("tx-modal").classList.add("active");
}

function closeTxModal() {
  document.getElementById("tx-modal").classList.remove("active");
}

function setupAutoCalculations() {
  const sharesInput = document.getElementById("tx-shares");
  const priceInput = document.getElementById("tx-price");
  const typeInput = document.getElementById("tx-type");
  const nameInput = document.getElementById("tx-name");
  
  // Remove existing listeners
  sharesInput.oninput = updateModalCalcPreview;
  priceInput.oninput = updateModalCalcPreview;
  typeInput.onchange = () => {
    autoSuggestFeeAndTax();
    updateModalCalcPreview();
  };
  nameInput.onchange = () => {
    autoSuggestFeeAndTax();
    updateModalCalcPreview();
  };
}

function autoSuggestFeeAndTax() {
  const type = document.getElementById("tx-type").value;
  const name = document.getElementById("tx-name").value;
  const shares = parseFloat(document.getElementById("tx-shares").value) || 0;
  const price = parseFloat(document.getElementById("tx-price").value) || 0;
  const amount = shares * price;

  if (amount === 0) return;

  // Taiwan ETF transaction rates:
  // Fee = 0.1425% (often with broker discount, e.g. 28% discount -> 0.0399%). Minimum is usually 1 TWD.
  // Tax = 0.1% for ETFs on sell.
  const isEtf = ["元大台灣50", "富邦台50", "元大S&P500", "富邦NASDAQ"].includes(name);
  
  // Calculate standard 2.8折 fee
  const fee = Math.max(1, Math.round(amount * 0.001425 * 0.28));
  document.getElementById("tx-fee").value = fee;

  if (type === "sell") {
    const taxRate = isEtf ? 0.001 : 0.003; // 0.1% for ETF, 0.3% for ordinary stocks
    const tax = Math.round(amount * taxRate);
    document.getElementById("tx-tax").value = tax;
  } else {
    document.getElementById("tx-tax").value = 0;
  }
}

function updateModalCalcPreview() {
  const type = document.getElementById("tx-type").value;
  const shares = parseFloat(document.getElementById("tx-shares").value) || 0;
  const price = parseFloat(document.getElementById("tx-price").value) || 0;
  const fee = parseFloat(document.getElementById("tx-fee").value) || 0;
  const tax = parseFloat(document.getElementById("tx-tax").value) || 0;

  const rawAmount = shares * price;
  let net = 0;

  if (type === "buy") {
    net = rawAmount + fee;
    document.getElementById("preview-label-tax").style.display = "none";
    document.getElementById("preview-tax-row").style.display = "none";
  } else {
    net = rawAmount - fee - tax;
    document.getElementById("preview-label-tax").style.display = "block";
    document.getElementById("preview-tax-row").style.display = "flex";
  }

  document.getElementById("preview-amount").innerText = `NT$ ${formatNumber(Math.round(rawAmount))}`;
  document.getElementById("preview-fee").innerText = `NT$ ${formatNumber(Math.round(fee))}`;
  document.getElementById("preview-tax").innerText = `NT$ ${formatNumber(Math.round(tax))}`;
  document.getElementById("preview-net").innerText = `NT$ ${formatNumber(Math.round(net))}`;
}

// Handle Form Submission
function saveTransaction(event) {
  event.preventDefault();

  const date = document.getElementById("tx-date").value;
  const type = document.getElementById("tx-type").value;
  const name = document.getElementById("tx-name").value;
  const shares = parseInt(document.getElementById("tx-shares").value);
  const price = parseFloat(document.getElementById("tx-price").value);
  const fee = parseInt(document.getElementById("tx-fee").value) || 0;
  const tax = parseInt(document.getElementById("tx-tax").value) || 0;

  if (!date || !name || isNaN(shares) || isNaN(price) || shares <= 0 || price <= 0) {
    showToast("請填寫所有必要欄位且數值需大於 0", "danger");
    return;
  }

  const rawAmount = shares * price;
  const net = type === "buy" ? (rawAmount + fee) : (rawAmount - fee - tax);
  const dir = type === "buy" ? "收" : "付";

  const txData = {
    date,
    type,
    name,
    shares,
    price,
    fee,
    tax,
    amount: Math.round(rawAmount),
    net: Math.round(net),
    dir
  };

  if (editingTransactionIndex >= 0) {
    // Edit mode
    transactions[editingTransactionIndex] = txData;
    showToast("交易紀錄已更新", "success");
  } else {
    // Add mode
    transactions.push(txData);
    showToast("成功新增交易紀錄", "success");
  }

  saveTransactionsToLocalStorage();
  
  // Make sure new stocks are initialized in prices
  if (prices[name] === undefined) {
    prices[name] = price;
    savePricesToLocalStorage();
  }

  closeTxModal();
  renderApp();
}

function deleteTransaction(index) {
  if (confirm("您確定要刪除此筆交易紀錄嗎？這可能會影響平均成本計算。")) {
    const t = transactions[index];
    transactions.splice(index, 1);
    saveTransactionsToLocalStorage();
    renderApp();
    showToast(`已刪除 ${t.name} 的交易紀錄`, "success");
  }
}

// Export / Import backups
function exportData() {
  const backup = {
    transactions,
    prices,
    loanConfig
  };
  const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(backup));
  const downloadAnchor = document.createElement('a');
  downloadAnchor.setAttribute("href", dataStr);
  
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, "");
  downloadAnchor.setAttribute("download", `portfolio_backup_${dateStr}.json`);
  
  document.body.appendChild(downloadAnchor);
  downloadAnchor.click();
  downloadAnchor.remove();
  showToast("備份檔案匯出成功！", "success");
}

function importData(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const imported = JSON.parse(e.target.result);
      if (Array.isArray(imported.transactions) && typeof imported.prices === 'object') {
        transactions = imported.transactions;
        prices = imported.prices;
        if (imported.loanConfig) {
          loanConfig = imported.loanConfig;
          saveLoanConfigToLocalStorage();
        }
        
        saveTransactionsToLocalStorage();
        savePricesToLocalStorage();
        renderApp();
        showToast("資料還原成功！", "success");
      } else {
        showToast("格式不合，請使用本系統導出的 JSON 檔案", "danger");
      }
    } catch (err) {
      showToast("解析檔案失敗！", "danger");
    }
  };
  reader.readAsText(file);
  // Clear input
  event.target.value = "";
}

// Reset portfolio to the initial 42 transactions
function resetToDefaults() {
  if (confirm("警告：此操作將清除所有您新增或編輯過的交易紀錄，並還原至原本的三張截圖明細資料。確定要還原嗎？")) {
    transactions = [...INITIAL_TRANSACTIONS];
    prices = { ...DEFAULT_PRICES };
    loanConfig = {
      baseAmount: 1597333,
      baseDate: "2026-06-02",
      monthlyDeduction: 22000,
      deductionDay: 2
    };
    
    saveTransactionsToLocalStorage();
    savePricesToLocalStorage();
    saveLoanConfigToLocalStorage();
    localStorage.setItem("portfolio_data_version", String(DATA_VERSION));
    renderApp();
    showToast("已重設為原始對帳單明細！", "success");
  }
}

// Calculate credit loan balance dynamically based on current date
function calculateLoanBalance() {
  if (!loanConfig.baseDate) {
    return { currentBalance: 0, monthsPassed: 0, totalDeducted: 0 };
  }
  const baseDate = new Date(loanConfig.baseDate);
  const now = new Date();
  
  // Calculate month difference
  let monthsPassed = (now.getFullYear() - baseDate.getFullYear()) * 12 + (now.getMonth() - baseDate.getMonth());
  
  // If current day of month is less than the deduction day, it hasn't deducted yet this month
  if (now.getDate() < loanConfig.deductionDay) {
    monthsPassed--;
  }
  
  if (monthsPassed < 0) {
    monthsPassed = 0;
  }
  
  const totalDeducted = monthsPassed * loanConfig.monthlyDeduction;
  const currentBalance = Math.max(0, loanConfig.baseAmount - totalDeducted);
  
  return {
    currentBalance,
    monthsPassed,
    totalDeducted
  };
}

// Render inputs in loan configuration panel
function renderLoanInputs() {
  const loanBaseAmountEl = document.getElementById("loan-base-amount");
  const loanBaseDateEl = document.getElementById("loan-base-date");
  const loanDeductionEl = document.getElementById("loan-deduction");

  if (loanBaseAmountEl) loanBaseAmountEl.value = loanConfig.baseAmount;
  if (loanBaseDateEl) loanBaseDateEl.value = loanConfig.baseDate;
  if (loanDeductionEl) loanDeductionEl.value = loanConfig.monthlyDeduction;

  const loanInfo = calculateLoanBalance();
  const actualCapital = Math.max(0, portfolioSummary.totalInvested - loanInfo.currentBalance);

  const calcBalanceEl = document.getElementById("loan-calc-balance");
  const calcMonthsEl = document.getElementById("loan-calc-months");
  const calcCapitalEl = document.getElementById("loan-calc-capital");

  if (calcBalanceEl) calcBalanceEl.innerText = formatCurrency(loanInfo.currentBalance);
  if (calcMonthsEl) calcMonthsEl.innerText = `${loanInfo.monthsPassed} 期 (累計扣除 ${formatCurrency(loanInfo.totalDeducted)})`;
  if (calcCapitalEl) calcCapitalEl.innerText = formatCurrency(actualCapital);
}

// Update loan config from input events
function updateLoanConfig(key, value) {
  if (key === 'baseAmount' || key === 'monthlyDeduction') {
    loanConfig[key] = parseFloat(value) || 0;
  } else if (key === 'baseDate') {
    loanConfig[key] = value;
    // Extract deduction day from date string YYYY-MM-DD
    const parts = value.split('-');
    if (parts.length === 3) {
      loanConfig.deductionDay = parseInt(parts[2]) || 2;
    }
  }
  saveLoanConfigToLocalStorage();
  renderApp();
  showToast("信貸與槓桿參數已更新", "success");
}


// ─── Live Price Fetch from TWSE MIS API ───────────────────────────────────────

/**
 * Check whether the Taiwan stock market is currently open.
 * Market hours: Mon–Fri, 09:00–13:30 Taiwan time (UTC+8).
 */
function isTWSEMarketOpen() {
  const now = new Date();
  // Convert to Taiwan time (UTC+8)
  const twOffset = 8 * 60; // minutes
  const localOffset = now.getTimezoneOffset(); // minutes behind UTC
  const twTime = new Date(now.getTime() + (twOffset + localOffset) * 60000);

  const day = twTime.getDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false; // Weekend

  const h = twTime.getHours();
  const m = twTime.getMinutes();
  const totalMin = h * 60 + m;
  return totalMin >= 9 * 60 && totalMin <= 13 * 60 + 30;
}

/**
 * Build the TWSE MIS API query string for all stocks that have a mapping.
 */
function buildTWSEQuery() {
  const stockNames = getUniqueStockNames();
  const codes = stockNames
    .filter(name => STOCK_TWSE_MAP[name])
    .map(name => STOCK_TWSE_MAP[name]);
  if (codes.length === 0) return null;
  return codes.join('|');
}

/**
 * Fetch live prices from TWSE MIS via CORS proxies.
 * Updates the `prices` state and re-renders the UI.
 * Falls back through multiple proxy URLs if one fails.
 */
async function fetchLivePrices() {
  if (isPriceFetching) return;

  const query = buildTWSEQuery();
  if (!query) return;

  isPriceFetching = true;
  updateFetchStatusUI('loading');

  const TWSE_URL = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?json=1&delay=0&ex_ch=${encodeURIComponent(query)}`;

  const PROXY_URLS = [
    `https://corsproxy.io/?url=${encodeURIComponent(TWSE_URL)}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(TWSE_URL)}`
  ];

  let lastError = null;
  let succeeded = false;

  for (const proxyUrl of PROXY_URLS) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const resp = await fetch(proxyUrl, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!resp.ok) {
        lastError = new Error(`HTTP ${resp.status}`);
        continue;
      }

      const data = await resp.json();

      if (data.rtcode !== '0000' || !Array.isArray(data.msgArray)) {
        lastError = new Error('Invalid response from TWSE');
        continue;
      }

      let updatedCount = 0;
      data.msgArray.forEach(item => {
        const priceStr = item.z && item.z !== '-' ? item.z : item.pz;
        const price = parseFloat(priceStr);
        if (!isNaN(price) && price > 0) {
          const matchedName = Object.keys(STOCK_TWSE_MAP).find(name => {
            const code = STOCK_TWSE_MAP[name];
            return code.includes(item.c);
          });
          if (matchedName) {
            prices[matchedName] = price;
            updatedCount++;
          }
        }
      });

      if (updatedCount > 0) {
        savePricesToLocalStorage();
        lastPriceFetchTime = new Date();
        renderApp();
        updateFetchStatusUI('success');
        showToast(`已更新 ${updatedCount} 支標的現價 (${formatTime(lastPriceFetchTime)})`, 'success');
      } else {
        updateFetchStatusUI('closed');
      }

      succeeded = true;
      break;

    } catch (err) {
      lastError = err;
      console.warn('Proxy failed:', err.message);
    }
  }

  if (!succeeded) {
    if (!isTWSEMarketOpen()) {
      updateFetchStatusUI('closed');
    } else {
      console.warn('All live price fetch attempts failed:', lastError?.message);
      updateFetchStatusUI('error');
    }
  }

  isPriceFetching = false;
}

/**
 * Start or restart the auto-refresh timer.
 * Uses a shorter interval (30s) during market hours, longer (5min) otherwise.
 */
function startPriceAutoRefresh() {
  if (priceAutoRefreshTimer) clearInterval(priceAutoRefreshTimer);
  const tick = async () => {
    await fetchLivePrices();
  };
  const interval = isTWSEMarketOpen() ? 30000 : 300000;
  priceAutoRefreshTimer = setInterval(tick, interval);
}

/**
 * Update the live-price status indicator in the header.
 */
function updateFetchStatusUI(status) {
  const indicator = document.getElementById('live-price-indicator');
  const label = document.getElementById('live-price-label');
  if (!indicator || !label) return;

  const configs = {
    loading: { dot: '🔄', text: '更新中…',        color: '#f59e0b' },
    success: { dot: '🟢', text: lastPriceFetchTime ? `${formatTime(lastPriceFetchTime)} 更新` : '已更新', color: '#10b981' },
    closed:  { dot: '🟡', text: '收盤(使用前收)', color: '#f59e0b' },
    error:   { dot: '🔴', text: '更新失敗',        color: '#ef4444' },
  };

  const cfg = configs[status] || configs.error;
  indicator.textContent = cfg.dot;
  label.textContent = cfg.text;
  label.style.color = cfg.color;

  const statusContainer = document.getElementById('live-price-status');
  if (statusContainer) {
    if (status === 'loading') {
      statusContainer.classList.add('fetching');
    } else {
      statusContainer.classList.remove('fetching');
    }
  }
}

function formatTime(date) {
  if (!date) return '';
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

// ──────────────────────────────────────────────────────────────────────────────

// Toast utility
function showToast(message, type = "success") {
  const container = document.getElementById("toast-container");
  
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <span>${message}</span>
    <button class="toast-close" onclick="this.parentElement.remove()">✕</button>
  `;
  
  container.appendChild(toast);
  
  // Auto remove after 3.5 seconds
  setTimeout(() => {
    toast.style.animation = "slideIn 0.3s cubic-bezier(0.4, 0, 0.2, 1) reverse";
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// Bind event listeners
function initEventListeners() {
  // Search and filter listeners
  document.getElementById("search-tx").addEventListener("input", renderTransactionsTable);
  document.getElementById("filter-stock").addEventListener("change", renderTransactionsTable);
  document.getElementById("filter-type").addEventListener("change", renderTransactionsTable);

  // Form submission
  document.getElementById("transaction-form").addEventListener("submit", saveTransaction);
  
  // File import change trigger
  document.getElementById("file-import").addEventListener("change", importData);
}

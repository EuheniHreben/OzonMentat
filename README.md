# 🧠 OzonMentat

Инструмент для автоматизации расчёта поставок и анализа динамики SKU на маркетплейсе Ozon.

OzonMentat помогает селлеру принимать решения на основе данных:  
учитывает продажи, остатки, товары в пути, минимальные партии, будущие поставки,  
и формирует удобный интерфейс для анализа.

---

## 🚀 Основные возможности

### 📦 Прогрузка (Supply Loader)

- Анализ продаж за неделю по каждому SKU  
- Сглаживание истории продаж  
- Расчёт коэффициента спроса на основе тренда  
- Учёт остатков, товаров в пути и будущих поставок  
- Минимальные партии, минимальные запасы  
- Расчёт итоговой потребности  
- Сохранение истории прогрузок  

### 📊 Воронка (SKU Funnel)

- Показатели SKU: показы, клики, CTR, заказы, выручка  
- Поиск, сортировка, фильтры  
- Копирование артикулов в один клик  
- Категоризация товаров (активные / в поставке / спящие / отключённые)  

### 📁 Работа с внешними данными

- Загрузка Excel (cut-файлов) с будущими поставками  
- Чтение нескольких файлов одновременно  
- Автоматическое объединение данных  

---

## 🏗 Архитектура проекта

```
/public
   /cut                 # Excel-файлы будущих поставок

/backend
   server.js            # API и основной сервис
   loader.js            # Логика прогрузчика
   funnel.js            # Логика воронки
   ozonApi.js           # Обертка над API Ozon
   dataService.js       # Работа с файлами и историей

/frontend
   index.html
   app.js
   style.css

/data
   products.csv

config.js               # Настройки поведения
.env                    # Секреты и ключи
```

---

## 🔧 Установка и запуск

### 1. Клонировать репозиторий

```bash
git clone https://github.com/<yourname>/OzonMentat.git
cd OzonMentat
```

### 2. Установить зависимости

```bash
npm install
```

### 3. Создать `.env`

```env
OZON_CLIENT_ID=xxxx
OZON_API_KEY=xxxx
GOOGLE_SHEET_ID=xxxx
GOOGLE_SERVICE_ACCOUNT_JSON=xxxx
```

### 4. Запуск проекта

```bash
npm start
```

---

## 📈 Как рассчитывается потребность по SKU

- Берём продажи за последние 7 дней  
- Сглаживаем историю  
- Определяем тренд спроса  
- Адаптируем коэффициент спроса  
- Учитываем:
  - остаток в Ozon  
  - товары в пути  
  - будущие поставки из Excel  
- Ограничиваем по максимальным дням хранения  
- Округляем по минимальной партии  
- Формируем итоговую рекомендацию по поставке  

---

## 🗄 История и данные

Система сохраняет:

- историю продаж  
- историю расчётов  
- индивидуальные настройки SKU  
- будущие поставки  

---

## 👨‍💼 Роль автора

В рамках разработки я выполнял:

- проектирование логики расчёта спроса  
- определение архитектуры приложения  
- формирование требований и структуры данных  
- тестирование и проверку корректности поведения системы  
- интеграцию модулей и настройку работы интерфейса  

При разработке части кода использовались инструменты AI,  
но логика, структура и правила работы системы создавались мной.

---

## 📌 Планы развития

- Аналитика маржи и DRR  
- Графики динамики продаж  
- Модуль ценообразования  
- Автоматическая оценка сезонности  
- Панель управления SKU-настройками  

---

# 🇬🇧 English Version

# 🧠 OzonMentat

A tool for automating supply calculations and analyzing SKU dynamics on the Ozon marketplace.

OzonMentat helps sellers make data‑driven decisions by evaluating sales, stock levels, goods in transit, minimum batch sizes, upcoming supplies,  
and providing a clear interface for SKU analytics.

---

## 🚀 Features

### 📦 Supply Loader

- Weekly SKU sales analysis  
- Historical smoothing  
- Demand coefficient based on trend detection  
- Stock, in‑transit goods, and future supply handling  
- Minimum stock and batch-size logic  
- Final supply recommendation  
- Supply history logging  

### 📊 SKU Funnel

- SKU metrics: impressions, clicks, CTR, orders, revenue  
- Search, sorting, filters  
- One‑click SKU copying  
- Categorization: active / in supply / dormant / disabled  

### 📁 External Data Support

- Excel (cut‑files) import for upcoming supplies  
- Multi‑file reading  
- Automatic unification of incoming data  

---

## 🏗 Project Structure

```
/public
   /cut                   # Upcoming supply Excel files

/backend
   server.js              # API & backend service
   loader.js              # Supply calculation logic
   funnel.js              # Funnel analytics logic
   ozonApi.js             # Ozon API wrapper
   dataService.js         # History & file utilities

/frontend
   index.html
   app.js
   style.css

/data
   products.csv

config.js                 # Behavior settings
.env                      # Secrets & credentials
```

---

## 🔧 Installation

### 1. Clone the repository

```bash
git clone https://github.com/<yourname>/OzonMentat.git
cd OzonMentat
```

### 2. Install dependencies

```bash
npm install
```

### 3. Create `.env`

```env
OZON_CLIENT_ID=xxxx
OZON_API_KEY=xxxx
GOOGLE_SHEET_ID=xxxx
GOOGLE_SERVICE_ACCOUNT_JSON=xxxx
```

### 4. Start the project

```bash
npm start
```

---

## 📈 How Supply is Calculated

- Retrieve last 7 days of sales  
- Smooth historical data  
- Determine sales trend  
- Adapt demand coefficient  
- Consider:
  - Ozon stock  
  - goods in transit  
  - future Excel supplies  
- Restrict by max stock‑days  
- Round by batch size  
- Produce final supply recommendation  

---

## 🗄 Data & Persistence

The system stores:

- sales history  
- supply calculation history  
- individual SKU settings  
- planned future supplies  

---

## 👨‍💼 Author Role

Responsibilities included:

- designing demand calculation logic  
- defining overall system architecture  
- specifying requirements and data structure  
- testing and validation  
- integrating modules and configuring UI workflows  

Some code was generated with AI assistance,  
but all logic, rules, and system structure were designed by me.

---

## 📌 Roadmap

- Margin & DRR analytics  
- Sales trend charts  
- Dynamic pricing module  
- Seasonality analysis  
- SKU settings management panel  

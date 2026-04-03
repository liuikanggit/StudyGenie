// 答题宝 Application Logic

const apiBase = '/api';

const app = {
    state: {
        questions: [],
        records: {},
        answers: {},
        wrongBook: [],
        currentView: 'home',
        currentMode: 'practice', // practice, exam, review
        currentQIndex: 0,
        examQuestions: [],
        examAnswers: {}, // id -> user's selected string
        examHistory: [], // saved past exam results
        examTimer: null,
        examTimeLeft: 3600, // 60 mins
        reviewSessionRecords: {}, // track review attempts
        reviewSessionAnswers: {},
        autoNext: false
    },

    init: async function() {
        this.bindEvents();
        this.bindAntiCheat();
        await this.loadData();
        this.switchView('home');
    },

    bindEvents: function() {
        document.querySelectorAll('.nav-btn[data-view]').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                if (this.state.currentMode === 'exam' && this.state.examTimer) {
                    const ok = await this.confirm("正在考试中，此时切换菜单将视为放弃考试并零分交卷，确认要离开吗？", "确定要弃考吗？");
                    if (!ok) return;
                    await this.submitExam(true, true, true); // force true, zero score true, isCheat true
                }
                this.switchView(e.target.dataset.view);
            });
        });
        document.getElementById('settings-btn').addEventListener('click', () => {
            this.openSettings();
        });
    },

    showToast: function(msg) {
        const t = document.getElementById('toast');
        t.innerText = msg;
        t.classList.add('show');
        setTimeout(() => t.classList.remove('show'), 2500);
    },

    bindAntiCheat: function() {
        // Prevent tab close/refresh
        window.addEventListener('beforeunload', (e) => {
            if (app.state.currentMode === 'exam' && app.state.examTimer) {
                e.preventDefault();
                e.returnValue = "正在考试中，离开页面将丢弃进度！";
            }
        });
        
        // Prevent tab switch (visibility API)
        document.addEventListener('visibilitychange', async () => {
            if (document.hidden && app.state.currentMode === 'exam' && app.state.examTimer) {
                await app.alert("反作弊警告：系统检测到您切换了浏览器页签/窗口，考试已强制结束并自动交卷！", "防作弊提醒");
                app.submitExam(true, true, true); // force=true, forceZero=true, isCheat=true
            }
        });
    },

    _orderQuestions(list) {
        const typeWeights = {
            '判断题': 0,
            '单选题': 1,
            '多选题': 2,
            '填空题': 3
        };
        return list.sort((a, b) => {
            const wa = typeWeights[a.type] !== undefined ? typeWeights[a.type] : 99;
            const wb = typeWeights[b.type] !== undefined ? typeWeights[b.type] : 99;
            if (wa !== wb) return wa - wb;
            return a.id - b.id; // secondary sort by original order
        });
    },

    async loadData() {
        try {
            const reqQ = await fetch(`${apiBase}/questions`);
            const allQuestions = await reqQ.json();
            this.state.questions = this._orderQuestions(allQuestions);
            
            const reqR = await fetch(`${apiBase}/records`);
            const resR = await reqR.json();
            this.state.records = resR.records || {};
            this.state.answers = resR.answers || {};

            const reqW = await fetch(`${apiBase}/wrong_book`);
            const resW = await reqW.json();
            this.state.wrongBook = resW.wrong_ids || [];

            const reqAuto = await fetch(`${apiBase}/settings/auto_next`);
            const resAuto = await reqAuto.json();
            this.state.autoNext = resAuto.value === 'true';

            this.updateStats();
        } catch (e) {
            console.error(e);
            this.showToast('数据加载失败，服务未响应');
        }
    },

    updateStats: function() {
        document.getElementById('stat-total').innerText = this.state.questions.length;
        const answered = Object.keys(this.state.records).length;
        document.getElementById('stat-answered').innerText = answered;
        
        let correctCt = 0;
        for (let k in this.state.records) {
            if (this.state.records[k]) correctCt++;
        }
        const acc = answered === 0 ? 0 : Math.round((correctCt / answered) * 100);
        document.getElementById('stat-accuracy').innerText = `${acc}%`;
        
        const prog = this.state.questions.length === 0 ? 0 : Math.round((answered / this.state.questions.length) * 100);
        document.getElementById('stat-progress-text').innerText = `进度 ${prog}%`;

        document.getElementById('stat-wrong').innerText = this.state.wrongBook.length;
    },

    // --- View Navigation ---
    switchView: function(viewName) {
        document.querySelectorAll('.view').forEach(v => v.classList.remove('section-active'));
        document.querySelectorAll('.nav-btn[data-view]').forEach(b => b.classList.remove('active'));
        const btn = document.querySelector(`.nav-btn[data-view="${viewName}"]`);
        if(btn) btn.classList.add('active');

        this.state.currentView = viewName;
        window.scrollTo(0,0);

        if (viewName === 'home') {
            document.getElementById('view-home').classList.add('section-active');
            this.loadData(); // reload stats
        } else if (viewName === 'practice') {
            document.getElementById('view-quiz').classList.add('section-active');
            this.startPractice();
        } else if (viewName === 'exam') {
            document.getElementById('view-exam-start').classList.add('section-active');
            this.loadExamHistory();
        } else if (viewName === 'review') {
            document.getElementById('view-quiz').classList.add('section-active');
            this.startReview();
        } else if (viewName === 'result') {
            document.getElementById('view-result').classList.add('section-active');
            document.getElementById('btn-submit-exam').classList.add('hidden');
        }
    },

    // --- Core Logics ---
    _getActiveList: function() {
        if (this.state.currentMode === 'practice') return this.state.questions;
        if (this.state.currentMode === 'exam') return this.state.examQuestions;
        if (this.state.currentMode === 'review') {
            return this._orderQuestions(this.state.questions.filter(q => this.state.wrongBook.includes(q.id)));
        }
        return [];
    },

    startPractice: async function() {
        this.state.currentMode = 'practice';
        document.getElementById('toggle-catalog-btn').classList.remove('hidden');
        document.getElementById('exam-timer').classList.add('hidden');
        document.getElementById('btn-submit-exam').style.display = '';
        document.getElementById('btn-submit-exam').classList.add('hidden');

        // fetch progress
        const pReq = await fetch(`${apiBase}/settings/practice_progress`);
        const pRes = await pReq.json();
        let qIdx = parseInt(pRes.value || '0');
        if (qIdx >= this.state.questions.length) qIdx = 0;
        
        this.state.currentQIndex = qIdx;
        this.renderQuestion();
    },

    startReview: function() {
        if (this.state.wrongBook.length === 0) {
            this.showToast('太棒了，错题本是空的！');
            this.switchView('home');
            return;
        }
        this.state.currentMode = 'review';
        this.state.currentQIndex = 0;
        this.state.reviewSessionRecords = {};
        this.state.reviewSessionAnswers = {};
        
        document.getElementById('toggle-catalog-btn').classList.remove('hidden');
        document.getElementById('exam-timer').classList.add('hidden');
        document.getElementById('btn-submit-exam').style.display = '';
        document.getElementById('btn-submit-exam').classList.add('hidden');
        this.renderQuestion();
    },

    startExam: function() {
        document.querySelectorAll('.view').forEach(v => v.classList.remove('section-active'));
        document.getElementById('view-quiz').classList.add('section-active');
        
        this.state.currentMode = 'exam';
        document.getElementById('toggle-catalog-btn').classList.add('hidden');
        document.getElementById('btn-submit-exam').classList.remove('hidden');
        
        // Pick 100 questions randomly
        let shuffled = [...this.state.questions].sort(() => 0.5 - Math.random());
        this.state.examQuestions = this._orderQuestions(shuffled.slice(0, 100));
        if(this.state.examQuestions.length === 0) {
             this.showToast('题库为空');
             this.switchView('home');
             return;
        }
        this.state.examAnswers = {};
        this.state.currentQIndex = 0;
        
        // UI logic for timer
        document.getElementById('exam-timer').classList.remove('hidden');
        this.state.examTimeLeft = 3600; // 60 mins
        this.updateTimerUI();
        if(this.state.examTimer) clearInterval(this.state.examTimer);
        this.state.examTimer = setInterval(() => {
            this.state.examTimeLeft--;
            this.updateTimerUI();
            if (this.state.examTimeLeft <= 0) {
                this.submitExam(true, false); // force=true, forceZero=false, isCheat=false
            }
        }, 1000);

        this.renderQuestion();
    },

    updateTimerUI: function() {
        let m = Math.floor(this.state.examTimeLeft / 60).toString().padStart(2, '0');
        let s = (this.state.examTimeLeft % 60).toString().padStart(2, '0');
        document.getElementById('exam-timer').innerText = `${m}:${s}`;
    },

    renderQuestion: function() {
        const list = this._getActiveList();
        if(list.length === 0) {
            document.getElementById('q-text').innerText = "没有题目可以显示";
            document.getElementById('q-options').innerHTML = "";
            return;
        }

        const q = list[this.state.currentQIndex];
        document.getElementById('q-type-badge').innerText = q.type;
        document.getElementById('q-progress-text').innerText = `题号: ${this.state.currentQIndex + 1} / ${list.length}`;
        let qText = q.text.replace(/\s{3,}/g, ' <span class="q-underline"></span> ');
        document.getElementById('q-text').innerHTML = `${q.id}. ${qText}`;

        const optionsContainer = document.getElementById('q-options');
        optionsContainer.innerHTML = '';
        
        let hasAnswered = false;
        let selectedOptions = [];
        let historicalCorrect = null;

        if (this.state.currentMode === 'review') {
             if (this.state.reviewSessionRecords[q.id] !== undefined) {
                 hasAnswered = true;
                 historicalCorrect = this.state.reviewSessionRecords[q.id];
                 if (this.state.reviewSessionAnswers[q.id]) {
                     selectedOptions = this.state.reviewSessionAnswers[q.id].split(',');
                 }
             }
        } else if (this.state.currentMode === 'practice') {
             if (this.state.records[q.id] !== undefined) {
                 hasAnswered = true;
                 historicalCorrect = this.state.records[q.id];
                 if (this.state.answers[q.id]) {
                     selectedOptions = this.state.answers[q.id].split(',');
                 }
             }
        } else if (this.state.currentMode === 'exam') {
             if(this.state.examAnswers[q.id]) {
                 selectedOptions = this.state.examAnswers[q.id].split(',');
             }
        }

        // Render options based on type
        if (q.type === '填空题') {
             const html = `<input type="text" id="blank-input" class="form-control" autocomplete="off" placeholder="请输入答案，多个空请用逗号隔开" value="${selectedOptions.join(',')}" ${hasAnswered?'disabled':''}>`;
             optionsContainer.innerHTML = html;
             
             const inputEl = document.getElementById('blank-input');
             if (inputEl && this.state.currentMode === 'exam') {
                 inputEl.oninput = (e) => {
                     this.state.examAnswers[q.id] = e.target.value;
                 };
             }
        } else {
            let labels = ['A', 'B', 'C', 'D', 'E', 'F'];
            q.options.forEach((optText, i) => {
                let lbl = q.type === '判断题' ? optText : labels[i];
                let isSelected = selectedOptions.includes(lbl);
                
                let div = document.createElement('div');
                div.className = `option-item ${isSelected?'selected':''}`;
                div.dataset.val = lbl;
                div.innerHTML = `<div class="option-label">${lbl}</div><div class="option-content">${optText}</div>`;
                div.onclick = () => this.selectOption(div, q.type, lbl);
                optionsContainer.appendChild(div);
            });
        }
        
        // Reset dynamic panels
        document.getElementById('btn-ai').classList.add('hidden');
        document.getElementById('q-ai-box').classList.add('hidden');
        document.getElementById('q-ai-content').innerHTML = '';
        document.getElementById('q-feedback').classList.add('hidden');

        // Restore Catalog DB View matching
        this.renderCatalog();
        
        const checkBtn = document.getElementById('btn-check-ans');

        if (this.state.currentMode !== 'exam') {
            document.getElementById('btn-submit-exam').classList.add('hidden');
            if (hasAnswered) {
                checkBtn.classList.add('hidden');
                let correctAnswers = q.answer || [];
                let isCorrect = historicalCorrect;
                this.showFeedback(isCorrect, correctAnswers.join(', '));
                if (q.type !== '填空题') {
                    document.querySelectorAll('.option-item').forEach(d => {
                        d.classList.add('disabled');
                        let v = d.dataset.val;
                        const isCorrect = correctAnswers.includes(v);
                        const isSelected = selectedOptions.includes(v);
                        
                        if (isCorrect && isSelected) {
                            d.classList.add('correct');
                        } else if (isCorrect && !isSelected) {
                            d.classList.add('missed');
                        } else if (!isCorrect && isSelected) {
                            d.classList.add('wrong');
                        }
                    });
                }
                if (!isCorrect) document.getElementById('btn-ai').classList.remove('hidden');
            } else {
                checkBtn.classList.remove('hidden');
            }
        } else {
            checkBtn.classList.add('hidden');
            document.getElementById('btn-submit-exam').classList.remove('hidden');
        }
    },

    selectOption: function(el, type, val) {
        if (el.classList.contains('disabled')) return;

        if (this.state.currentMode === 'exam') {
            const list = this._getActiveList();
            const q = list[this.state.currentQIndex];
            
            if (type === '单选题' || type === '判断题') {
                // remove others
                document.querySelectorAll('.option-item').forEach(d => d.classList.remove('selected'));
                el.classList.add('selected');
                this.state.examAnswers[q.id] = val;
            } else if (type === '多选题') {
                el.classList.toggle('selected');
                let sels = Array.from(document.querySelectorAll('.option-item.selected')).map(d => d.dataset.val);
                this.state.examAnswers[q.id] = sels.join(',');
            }
        } else {
            // Practice Mode
            if (type === '单选题' || type === '判断题') {
                 document.querySelectorAll('.option-item').forEach(d => d.classList.remove('selected'));
                 el.classList.add('selected');
            } else if (type === '多选题') {
                 el.classList.toggle('selected');
            }
        }
    },

    async checkAnswer() {
        // practice or review mode check
        const list = this._getActiveList();
        const q = list[this.state.currentQIndex];
        let type = q.type;

        let userAns = [];
        if (type === '填空题') {
             let val = document.getElementById('blank-input').value.trim();
             if(val) userAns.push(val);
        } else {
             userAns = Array.from(document.querySelectorAll('.option-item.selected')).map(d => d.dataset.val);
        }

        if (userAns.length === 0) {
             this.showToast('请先选择或输入答案！');
             return;
        }

        // Lock options
        document.querySelectorAll('.option-item').forEach(d => d.classList.add('disabled'));
        const btn = document.getElementById('btn-check-ans');
        if(btn) btn.classList.add('hidden');
        const docBlank = document.getElementById('blank-input');
        if(docBlank) docBlank.disabled = true;

        // evaluate
        // Some docs answers are just text for blanks. We'll do exact string compare or check if option matches.
        // answer is an array
        let correctAnswers = q.answer || [];
        let isCorrect = this.arraysEqualMatch(userAns, correctAnswers, type);

        this.showFeedback(isCorrect, correctAnswers.join(', '));

        if (type !== '填空题') {
            document.querySelectorAll('.option-item').forEach(d => {
                let v = d.dataset.val;
                const isCorrect = correctAnswers.includes(v);
                const isSelected = userAns.includes(v);
                
                if (isCorrect && isSelected) {
                    d.classList.add('correct');
                } else if (isCorrect && !isSelected) {
                    d.classList.add('missed');
                } else if (!isCorrect && isSelected) {
                    d.classList.add('wrong');
                }
            });
        }

        // save to DB
        let userAnsStr = userAns.join(',');
        await fetch(`${apiBase}/records`, {
             method: 'POST',
             headers: {'Content-Type': 'application/json'},
             body: JSON.stringify({ question_id: q.id, is_correct: isCorrect, selected_answer: userAnsStr })
        });
        
        // Update local state immediately
        this.state.records[q.id] = isCorrect;
        this.state.answers[q.id] = userAnsStr;
        if (this.state.currentMode === 'review') {
             this.state.reviewSessionRecords[q.id] = isCorrect;
             this.state.reviewSessionAnswers[q.id] = userAnsStr;
        }
        if (!isCorrect && !this.state.wrongBook.includes(q.id)) {
            this.state.wrongBook.push(q.id);
        } else if (isCorrect && this.state.currentMode === 'review') {
            // Kick out of wrong book
            fetch(`${apiBase}/wrong_book/${q.id}`, {method: 'DELETE'});
            this.state.wrongBook = this.state.wrongBook.filter(id => id !== q.id);
            // Decrement index because the list just shrunk and items shifted left.
            // When user clicks Next (i++), they will land on the correct "next" item.
            this.state.currentQIndex--;
        }

        // Provide AI help if wrong
        if (!isCorrect) {
            document.getElementById('btn-ai').classList.remove('hidden');
        } else {
             if (this.state.autoNext && this.state.currentMode !== 'exam') {
                 setTimeout(() => {
                     // Check if still in a valid answering view
                     if (this.state.currentView === 'practice' || this.state.currentView === 'review') {
                         this.nextQuestion();
                     }
                 }, 1500);
             }
        }

        this.renderCatalog();
    },

    arraysEqualMatch(userArr, correctArr, type) {
         if (!userArr || userArr.length === 0) return false;
         
         if (type === '填空题') {
              // lenient check
              return userArr.join('') === (correctArr||[]).join('');
         }
         
         if (!correctArr || correctArr.length === 0) return false;
         
         if (userArr.length !== correctArr.length) return false;
         let sortedU = [...userArr].sort();
         let sortedC = [...correctArr].sort();
         for(let i=0; i<sortedU.length; i++) {
              if(sortedU[i] !== sortedC[i]) return false;
         }
         return true;
    },

    showFeedback(isCorrect, correctText) {
        const pan = document.getElementById('q-feedback');
        pan.classList.remove('hidden', 'correct-feedback', 'wrong-feedback');
        pan.classList.add(isCorrect ? 'correct-feedback' : 'wrong-feedback');
        const tit = isCorrect ? '回答正确！' : '回答错误！';
        const ic = isCorrect ? '✓' : '✗';
        document.getElementById('feedback-title').innerText = tit;
        document.getElementById('feedback-icon').innerText = ic;
        document.getElementById('q-correct-answer').innerText = correctText;
    },

    async askAI() {
        const list = this._getActiveList();
        const q = list[this.state.currentQIndex];
        
        const contentBox = document.getElementById('q-ai-content');
        // If there's already an explanation (not just a loader), we force a refresh on second click
        const isForce = contentBox.innerText.includes('正解') || contentBox.innerText.includes('错因');

        let userAns = [];
        if (q.type === '填空题') {
             userAns = [document.getElementById('blank-input').value];
        } else {
             userAns = Array.from(document.querySelectorAll('.option-item.selected')).map(d=>d.dataset.val);
        }

        let aiBox = document.getElementById('q-ai-box');
        aiBox.classList.remove('hidden');
        contentBox.innerHTML = '<span style="color:var(--primary)">大模型正在思考...</span>';

        try {
            const resp = await fetch(`${apiBase}/llm/explain`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ 
                    question: q, 
                    user_answer: userAns.join(','),
                    force: isForce
                })
            });
            
            if (!resp.ok) {
                const err = await resp.json();
                if (resp.status === 400) {
                     this.alert(err.error, "配置提醒");
                     contentBox.innerHTML = `<span style="color:var(--warning)">${err.error}</span>`;
                } else {
                     throw new Error(err.error || '解析失败');
                }
                return;
            }

            const reader = resp.body.getReader();
            const decoder = new TextDecoder();
            let accumulated = "";
            contentBox.innerHTML = "";
            
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                
                accumulated += decoder.decode(value, { stream: true });
                contentBox.innerHTML = marked.parse(accumulated);
                aiBox.scrollTop = aiBox.scrollHeight;
            }
        } catch (e) {
            contentBox.innerHTML = `<span style="color:var(--danger)">请求异常: ${e.message}</span>`;
        }
    },

    async nextQuestion() {
        if (this.state.currentMode === 'practice' || this.state.currentMode === 'review') {
             await this._promptUnsavedAnswer();
        }
        const list = this._getActiveList();
        if (this.state.currentQIndex < list.length - 1) {
             this.state.currentQIndex++;
             if (this.state.currentMode === 'practice') this._savePracticeProgress();
             this.renderQuestion();
        } else {
             this.showToast('已经是最后一题了');
        }
    },

    async prevQuestion() {
        if (this.state.currentMode === 'practice' || this.state.currentMode === 'review') {
             await this._promptUnsavedAnswer();
        }
        if (this.state.currentQIndex > 0) {
             this.state.currentQIndex--;
             if (this.state.currentMode === 'practice') this._savePracticeProgress();
             this.renderQuestion();
        } else {
             this.showToast('这是第一题');
        }
    },

    async _promptUnsavedAnswer() {
        const list = this._getActiveList();
        const q = list[this.state.currentQIndex];
        
        // If the 'Submit' button is hidden, it means we've already answered in this session.
        const checkBtn = document.getElementById('btn-check-ans');
        if (!checkBtn || checkBtn.classList.contains('hidden')) return;

        let hasSelection = false;
        if (q.type === '填空题') {
            const val = document.getElementById('blank-input')?.value.trim();
            if (val) hasSelection = true;
        } else {
            const sels = document.querySelectorAll('.option-item.selected');
            if (sels.length > 0) hasSelection = true;
        }

        if (hasSelection) {
            const ok = await this.confirm("发现您本题已选择但尚未提交判定，是否现在提交？\n(确定提交，取消则跳过)", "未提交提醒");
            if (ok) {
                await this.checkAnswer();
            }
        }
    },

    alert(message, title = "提示") {
        return this.confirm(message, title, true);
    },

    confirm(message, title = "确认操作", isAlert = false) {
        return new Promise((resolve) => {
            const modal = document.getElementById('app-confirm-modal');
            const titleEl = document.getElementById('confirm-title');
            const msgEl = document.getElementById('confirm-message');
            const okBtn = document.getElementById('confirm-ok');
            const cancelBtn = document.getElementById('confirm-cancel');

            titleEl.innerText = title;
            msgEl.innerText = message;
            
            if (isAlert) cancelBtn.style.display = 'none';
            else cancelBtn.style.display = 'block';

            modal.classList.add('active');

            const cleanup = (result) => {
                modal.classList.remove('active');
                okBtn.onclick = null;
                cancelBtn.onclick = null;
                modal.onclick = null;
                resolve(result);
            };

            okBtn.onclick = () => cleanup(true);
            cancelBtn.onclick = () => cleanup(false);
            modal.onclick = (e) => {
                if (e.target === modal) cleanup(false);
            };
        });
    },

    _savePracticeProgress() {
         fetch(`${apiBase}/settings`, {
             method: 'POST',
             headers: {'Content-Type': 'application/json'},
             body: JSON.stringify({ key: 'practice_progress', value: this.state.currentQIndex.toString() })
         });
    },

    // --- Exam Logic ---
    async submitExam(force = false, forceZero = false, isCheat = false) {
         if (!force) {
             const ok = await app.confirm("确定要提前交卷吗？一旦交卷将无法修改。", "提交试卷");
             if (!ok) return;
         }

         if (this.state.examTimer) {
             clearInterval(this.state.examTimer);
             this.state.examTimer = null;
         }
         
         let correctCt = 0;
         let wrongCt = 0;

         // Wrap in a promise set to wait for all records to be saved
         let recordPromises = [];

         this.state.examQuestions.forEach(q => {
             let userAnsStr = this.state.examAnswers[q.id] || "";
             let userAnsArr = userAnsStr.split(',').filter(x=>x);
             let isCorrect = this.arraysEqualMatch(userAnsArr, q.answer||[], q.type);
             
             if (isCorrect && !forceZero) {
                 correctCt++;
             } else {
                 wrongCt++;
             }

             // If not a cheat and was answered, record wrong questions into common records/wrong book
             if (!isCheat && !isCorrect && userAnsStr !== "") {
                 recordPromises.push(
                     fetch(`${apiBase}/records`, {
                         method: 'POST',
                         headers: {'Content-Type': 'application/json'},
                         body: JSON.stringify({ question_id: q.id, is_correct: false, selected_answer: userAnsStr })
                     })
                 );
             }
         });

         let total = this.state.examQuestions.length || 1;
         let score = Math.round((correctCt / total) * 100) || 0;
         
         // POST the result
         fetch(`${apiBase}/exam_records`, {
             method: 'POST',
             headers: {'Content-Type': 'application/json'},
             body: JSON.stringify({ score: score, correct_count: correctCt, total_count: this.state.examQuestions.length })
         });
         
         document.getElementById('exam-score').innerText = score;
         document.getElementById('exam-correct').innerText = correctCt;
         document.getElementById('exam-wrong').innerText = wrongCt;
         
         this.switchView('result');
         
         if (recordPromises.length > 0) {
             try {
                await Promise.all(recordPromises);
             } catch(e) { console.error("Records save failed", e); }
             this.loadData(); // refresh common records and wrong book
         }
    },

    async loadExamHistory() {
        try {
            const req = await fetch(`${apiBase}/exam_records`);
            const res = await req.json();
            this.state.examHistory = res.history || [];
            
            const container = document.getElementById('exam-history-container');
            const list = document.getElementById('exam-history-list');
            if (this.state.examHistory.length > 0) {
                 container.classList.remove('hidden');
                 list.innerHTML = '';
                 this.state.examHistory.forEach(h => {
                     // Convert SQLite 'YYYY-MM-DD HH:MM:SS' into 'YYYY-MM-DDTHH:MM:SSZ' for correct timezone formatting
                     let isoTime = h.time.replace(' ', 'T') + 'Z';
                     let dt = new Date(isoTime).toLocaleString('zh-CN', {month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit'});
                     let card = document.createElement('div');
                     card.className = 'stat-card';
                     card.style.minWidth = '120px';
                     card.innerHTML = `<div class="stat-title">${dt}</div><div class="stat-value">${h.score}分</div>`;
                     list.appendChild(card);
                 });
            } else {
                 container.classList.add('hidden');
            }
        } catch (e) {
            console.error(e);
        }
    },

    // --- Settings & Modal ---
    openSettings: async function() {
        document.getElementById('settings-modal').classList.add('active');
        const reqB = await fetch(`${apiBase}/settings/dashscope_api_key`);
        const resB = await reqB.json();
        document.getElementById('input-api-key').value = resB.value || "";
        document.getElementById('input-auto-next').checked = this.state.autoNext;
    },

    saveSettings: async function() {
        const valApiKey = document.getElementById('input-api-key').value;
        await fetch(`${apiBase}/settings`, {
             method: 'POST',
             headers: {'Content-Type': 'application/json'},
             body: JSON.stringify({ key: 'dashscope_api_key', value: valApiKey })
        });

        const valAuto = document.getElementById('input-auto-next').checked;
        this.state.autoNext = valAuto;
        await fetch(`${apiBase}/settings`, {
             method: 'POST',
             headers: {'Content-Type': 'application/json'},
             body: JSON.stringify({ key: 'auto_next', value: valAuto.toString() })
        });

        document.getElementById('settings-modal').classList.remove('active');
        this.showToast('设置已保存');
    },

    async resetAll() {
        const ok = await this.confirm("确定要删除所有刷题记录和错题本吗？此操作无法恢复！", "重置所有记录");
        if(ok) {
            await fetch(`${apiBase}/reset_records`, {method: 'POST'});
            this.showToast('记录已全部清空');
            this.init(); // reload all data
        }
    },

    // --- Catalog ---
    toggleCatalog() {
        const d = document.getElementById('catalog-drawer');
        const o = document.getElementById('drawer-overlay');
        d.classList.toggle('open');
        if(o) o.classList.toggle('active');
        if(d.classList.contains('open')){
             this.renderCatalog();
        }
    },

    renderCatalog() {
        const grid = document.getElementById('catalog-grid');
        grid.innerHTML = '';
        const list = this._getActiveList();
        
        let lastType = null;
        list.forEach((q, idx) => {
            if (q.type !== lastType) {
                 const header = document.createElement('div');
                 header.className = 'catalog-section-header';
                 header.innerText = q.type;
                 grid.appendChild(header);
                 lastType = q.type;
            }

            let div = document.createElement('div');
            div.className = 'catalog-item';
            div.innerText = idx + 1;
            
            // If practice, show state
            if (this.state.currentMode === 'practice' || this.state.currentMode === 'review') {
                if (this.state.records[q.id] === true) div.classList.add('correct');
                else if (this.state.records[q.id] === false) div.classList.add('wrong');
            }
            if (idx === this.state.currentQIndex) div.classList.add('current');

            div.onclick = () => {
                this.state.currentQIndex = idx;
                this.renderQuestion();
                this.toggleCatalog();
            };
            grid.appendChild(div);
        });
    }

};

document.addEventListener('DOMContentLoaded', () => {
    app.init();
});
